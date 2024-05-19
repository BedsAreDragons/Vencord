import definePlugin from "@utils/types";

export default definePlugin({
    name: "Radio Voice Plugin",
    description: "This plugin makes all incoming voice sound like a radio.",
    authors: [
        {
            id: 0n, // Replace with your actual user ID if you want
            name: "Your Name",
        },
    ],
    patches: [],
    start() {
        this.initializeAudioContext();
        this.applyRadioEffect();
    },
    stop() {
        this.cleanupAudioContext();
    },
    initializeAudioContext() {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        this.gainNode = this.audioContext.createGain();
        this.biquadFilter = this.audioContext.createBiquadFilter();
        this.whiteNoise = this.audioContext.createBufferSource();

        // Configure the gain node (volume)
        this.gainNode.gain.value = 0.5;

        // Configure the biquad filter (equalizer)
        this.biquadFilter.type = "bandpass";
        this.biquadFilter.frequency.value = 1000; // Center frequency
        this.biquadFilter.Q.value = 1; // Quality factor

        // Configure white noise (static effect)
        const bufferSize = this.audioContext.sampleRate * 2;
        const buffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }
        this.whiteNoise.buffer = buffer;
        this.whiteNoise.loop = true;

        // Connect the nodes
        this.whiteNoise.connect(this.gainNode);
        this.gainNode.connect(this.biquadFilter);
        this.biquadFilter.connect(this.audioContext.destination);

        // Start the white noise
        this.whiteNoise.start();
    },
    applyRadioEffect() {
        // Hook into Vencord's audio stream
        // Note: You will need to find the correct way to access and modify the voice stream in Vencord's codebase
        // This might involve using internal functions or API hooks provided by Vencord

        const originalHandleVoiceData = VencordAPI.getVoiceHandler();
        
        VencordAPI.setVoiceHandler((data) => {
            const audioBuffer = this.audioContext.decodeAudioData(data);

            const source = this.audioContext.createBufferSource();
            source.buffer = audioBuffer;

            source.connect(this.gainNode);
            this.gainNode.connect(this.biquadFilter);
            this.biquadFilter.connect(this.audioContext.destination);

            source.start();

            return originalHandleVoiceData(data);
        });
    },
    cleanupAudioContext() {
        if (this.audioContext) {
            this.audioContext.close();
        }
    }
});
