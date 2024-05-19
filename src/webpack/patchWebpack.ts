/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { canonicalizeMatch, canonicalizeReplacement } from "@utils/patches";
import { PatchReplacement } from "@utils/types";
import { WebpackInstance } from "discord-types/other";

import { traceFunction } from "../debug/Tracer";
import { patches } from "../plugins";
import { _initWebpack, beforeInitListeners, factoryListeners, moduleListeners, subscriptions, wreq } from ".";

// Proxies demand that these properties be unmodified, so our module proxy
// will always return the function default for them.
const unconfigurable = ["arguments", "caller", "prototype"];

const logger = new Logger("WebpackInterceptor", "#8caaee");
const initCallbackRegex = canonicalizeMatch(/{return \i\(".+?"\)}/);

// wreq.O is the webpack onChunksLoaded function
// Discord uses it to await for all the chunks to be loaded before initializing the app
// We monkey patch it to also monkey patch the initialize app callback to get immediate access to the webpack require and run our listeners before doing it
Object.defineProperty(Function.prototype, "O", {
    configurable: true,

    set(onChunksLoaded: any) {
        // When using react devtools or other extensions, or even when discord loads the sentry, we may also catch their webpack here.
        // This ensures we actually got the right one
        // this.e (wreq.e) is the method for loading a chunk, and only the main webpack has it
        const { stack } = new Error();
        if ((stack?.includes("discord.com") || stack?.includes("discordapp.com")) && String(this.e).includes("Promise.all")) {
            logger.info("Found main WebpackRequire.onChunksLoaded");

            delete (Function.prototype as any).O;

            const originalOnChunksLoaded = onChunksLoaded;
            onChunksLoaded = function (this: unknown, result: any, chunkIds: string[], callback: () => any, priority: number) {
                if (callback != null && initCallbackRegex.test(callback.toString())) {
                    Object.defineProperty(this, "O", {
                        value: originalOnChunksLoaded,
                        configurable: true
                    });

                    const wreq = this as WebpackInstance;

                    const originalCallback = callback;
                    callback = function (this: unknown) {
                        logger.info("Patched initialize app callback invoked, initializing our internal references to WebpackRequire and running beforeInitListeners");
                        _initWebpack(wreq);

                        for (const beforeInitListener of beforeInitListeners) {
                            beforeInitListener(wreq);
                        }

                        originalCallback.apply(this, arguments as any);
                    };

                    callback.toString = originalCallback.toString.bind(originalCallback);
                    arguments[2] = callback;
                }

                originalOnChunksLoaded.apply(this, arguments as any);
            };

            onChunksLoaded.toString = originalOnChunksLoaded.toString.bind(originalOnChunksLoaded);
        }

        Object.defineProperty(this, "O", {
            value: onChunksLoaded,
            configurable: true
        });
    }
});

// wreq.m is the webpack object containing module factories.
// This is pre-populated with modules, and is also populated via webpackGlobal.push
// We replace its prototype with our proxy, which is responsible for returning patched module factories
// the first time they are accessed, so the module factories are ran containing our patches
Object.defineProperty(Function.prototype, "m", {
    configurable: true,

    set(originalModules: any) {
        // When using react devtools or other extensions, we may also catch their webpack here.
        // This ensures we actually got the right one
        const { stack } = new Error();
        if (stack?.includes("discord.com") || stack?.includes("discordapp.com")) {
            logger.info("Found Webpack module factory", stack.match(/\/assets\/(.+?\.js)/)?.[1] ?? "");

            // The new object which will contain the factories
            const modules = Object.assign({}, originalModules);

            // Clear the original object so pre-populated factories are patched
            for (const prop of Object.getOwnPropertyNames(originalModules)) {
                delete originalModules[prop];
            }

            const patchedModules = new Set<string>();
            Object.setPrototypeOf(originalModules, new Proxy(modules, getModulesProxyHandler(patchedModules)));
        }

        Object.defineProperty(this, "m", {
            value: originalModules,
            configurable: true
        });
    }
});

function getModulesProxyHandler(patchedModules: Set<string>): ProxyHandler<any> {
    return {
        ...Object.fromEntries(Object.getOwnPropertyNames(Reflect).map(propName =>
            [propName, (target: any, ...args: any[]) => Reflect[propName](target, ...args)]
        )),

        get: (target, p: string) => {
            const mod = Reflect.get(target, p);
            // If the property is not a module id, return the value of it without trying to patch
            if (mod == null || Number.isNaN(Number(p)) || patchedModules.has(p)) return mod;

            patchedModules.add(p);
            return patchFactory(p, mod);
        },

        set: (target, p, newValue) => Reflect.set(target, p, newValue),

        ownKeys: target => {
            const keys = Reflect.ownKeys(target);
            for (const key of unconfigurable) {
                if (!keys.includes(key)) keys.push(key);
            }
            return keys;
        },

        getOwnPropertyDescriptor: (target, p) => {
            if (typeof p === "string" && unconfigurable.includes(p))
                return Reflect.getOwnPropertyDescriptor(target, p);

            const descriptor = Reflect.getOwnPropertyDescriptor(target, p);
            if (descriptor) Object.defineProperty(target, p, descriptor);
            return descriptor;
        }
    };
}

let webpackNotInitializedLogged = false;

function patchFactory(id: string, mod: (module: any, exports: any, require: WebpackInstance) => void) {
    const originalMod = mod;
    const patchedBy = new Set();

    for (const factoryListener of factoryListeners) {
        try {
            factoryListener(originalMod);
        } catch (err) {
            logger.error("Error in Webpack factory listener:\n", err, factoryListener);
        }
    }

    // Discords Webpack chunks for some ungodly reason contain random
    // newlines. Cyn recommended this workaround and it seems to work fine,
    // however this could potentially break code, so if anything goes weird,
    // this is probably why.
    // Additionally, `[actual newline]` is one less char than "\n", so if Discord
    // ever targets newer browsers, the minifier could potentially use this trick and
    // cause issues.
    //
    // 0, prefix is to turn it into an expression: 0,function(){} would be invalid syntax without the 0,
    let code: string = "0," + mod.toString().replaceAll("\n", "");

    for (let i = 0; i < patches.length; i++) {
        const patch = patches[i];
        if (patch.predicate && !patch.predicate()) continue;

        const moduleMatches = typeof patch.find === "string"
            ? code.includes(patch.find)
            : patch.find.test(code);

        if (!moduleMatches) continue;

        patchedBy.add(patch.plugin);

        const executePatch = traceFunction(`patch by ${patch.plugin}`, (match: string | RegExp, replace: string) => code.replace(match, replace));
        const previousMod = mod;
        const previousCode = code;

        // We change all patch.replacement to array in plugins/index
        for (const replacement of patch.replacement as PatchReplacement[]) {
            if (replacement.predicate && !replacement.predicate()) continue;

            const lastMod = mod;
            const lastCode = code;

            canonicalizeReplacement(replacement, patch.plugin);

            try {
                const newCode = executePatch(replacement.match, replacement.replace as string);
                if (newCode === code) {
                    if (!patch.noWarn) {
                        logger.warn(`Patch by ${patch.plugin} had no effect (Module id is ${id}): ${replacement.match}`);
                        if (IS_DEV) {
                            logger.debug("Function Source:\n", code);
                        }
                    }

                    if (patch.group) {
                        logger.warn(`Undoing patch group ${patch.find} by ${patch.plugin} because replacement ${replacement.match} had no effect`);
                        mod = previousMod;
                        code = previousCode;
                        patchedBy.delete(patch.plugin);
                        break;
                    }

                    continue;
                }

                code = newCode;
                mod = (0, eval)(`// Webpack Module ${id} - Patched by ${[...patchedBy].join(", ")}\n${newCode}\n//# sourceURL=WebpackModule${id}`);
            } catch (err) {
                logger.error(`Patch by ${patch.plugin} errored (Module id is ${id}): ${replacement.match}\n`, err);

                if (IS_DEV) {
                    const changeSize = code.length - lastCode.length;
                    const match = lastCode.match(replacement.match)!;

                    // Use 200 surrounding characters of context
                    const start = Math.max(0, match.index! - 200);
                    const end = Math.min(lastCode.length, match.index! + match[0].length + 200);
                    // (changeSize may be negative)
                    const endPatched = end + changeSize;

                    const context = lastCode.slice(start, end);
                    const patchedContext = code.slice(start, endPatched);

                    // inline require to avoid including it in !IS_DEV builds
                    const diff = (require("diff") as typeof import("diff")).diffWordsWithSpace(context, patchedContext);
                    let fmt = "%c %s ";
                    const elements = [] as string[];
                    for (const d of diff) {
                        const color = d.removed
                            ? "red"
                            : d.added
                                ? "lime"
                                : "grey";
                        fmt += "%c%s";
                        elements.push("color:" + color, d.value);
                    }

                    logger.errorCustomFmt(...Logger.makeTitle("white", "Before"), context);
                    logger.errorCustomFmt(...Logger.makeTitle("white", "After"), patchedContext);
                    const [titleFmt, ...titleElements] = Logger.makeTitle("white", "Diff");
                    logger.errorCustomFmt(titleFmt + fmt, ...titleElements, ...elements);
                }

                patchedBy.delete(patch.plugin);

                if (patch.group) {
                    logger.warn(`Undoing patch group ${patch.find} by ${patch.plugin} because replacement ${replacement.match} errored`);
                    mod = previousMod;
                    code = previousCode;
                    break;
                }

                mod = lastMod;
                code = lastCode;
            }
        }

        if (!patch.all) patches.splice(i--, 1);
    }

    wreq.m[id] = function (module: any, exports: any, require: WebpackInstance) {
        if (wreq == null && IS_DEV) {
            if (!webpackNotInitializedLogged) {
                webpackNotInitializedLogged = true;
                logger.error("WebpackRequire was not initialized, running modules without patches instead.");
            }

            return void originalMod(module, exports, require);
        }

        try {
            mod(module, exports, require);
        } catch (err) {
            // Just rethrow Discord errors
            if (mod === originalMod) throw err;

            logger.error("Error in patched module", err);
            return void originalMod(module, exports, require);
        }

        exports = module.exports;
        if (!exports) return;

        // There are (at the time of writing) 11 modules exporting the window
        // Make these non enumerable to improve webpack search performance
        if (exports === window && require.c) {
            Object.defineProperty(require.c, id, {
                value: require.c[id],
                configurable: true,
                writable: true,
                enumerable: false
            });
            return;
        }

        for (const callback of moduleListeners) {
            try {
                callback(exports, id);
            } catch (err) {
                logger.error("Error in Webpack module listener:\n", err, callback);
            }
        }

        for (const [filter, callback] of subscriptions) {
            try {
                if (filter(exports)) {
                    subscriptions.delete(filter);
                    callback(exports, id);
                } else if (exports.default && filter(exports.default)) {
                    subscriptions.delete(filter);
                    callback(exports.default, id);
                }
            } catch (err) {
                logger.error("Error while firing callback for Webpack subscription:\n", err, filter, callback);
            }
        }
    };

    return wreq.m[id];
}
