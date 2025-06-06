/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, LiveServerMessage, Modality, Session} from '@google/genai';
import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData} from './utils';
import './visual-3d';

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = 'Initializing...';
  @state() error = '';

  private client: GoogleGenAI;
  private session: Session;
  private inputAudioContext = new (window.AudioContext ||
    window.webkitAudioContext)({sampleRate: 16000});
  private outputAudioContext = new (window.AudioContext ||
    window.webkitAudioContext)({sampleRate: 24000, latencyHint: 'playback' }); // Added latencyHint
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: AudioBufferSourceNode;
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();

  // Properties for speaker output
  private outputMediaElement: HTMLAudioElement;
  private mediaStreamDestination: MediaStreamAudioDestinationNode;

  static styles = css`
    #status {
      position: absolute;
      bottom: 5vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
      color: #eee; /* Light color for status */
      font-family: sans-serif;
    }

    .controls {
      z-index: 10;
      position: absolute;
      bottom: 10vh;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;

      button {
        outline: none;
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.1);
        width: 64px;
        height: 64px;
        cursor: pointer;
        font-size: 24px;
        padding: 0;
        margin: 0;
        display: flex; /* For centering icon */
        align-items: center; /* For centering icon */
        justify-content: center; /* For centering icon */

        &:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      }

      button[disabled] {
        /* Keep visible but change appearance for disabled state */
        opacity: 0.5;
        cursor: not-allowed;
        /* display: none; */ /* Avoid layout shifts by not using display:none */
      }
    }
  `;

  constructor() {
    super();
    this.initClient().catch(err => {
        console.error("Initialization failed:", err);
        this.updateError(`Critical init error: ${err.message}`);
    });
  }

  private async resumeOutputAudio() {
    if (this.outputAudioContext.state === 'suspended') {
      console.log('Output AudioContext is suspended, resuming...');
      await this.outputAudioContext.resume();
      console.log('Output AudioContext resumed. State:', this.outputAudioContext.state);
    }
    if (this.outputMediaElement && this.outputMediaElement.paused) {
      console.log('Output media element is paused, attempting to play...');
      try {
        await this.outputMediaElement.play();
        console.log('Output media element played successfully.');
      } catch (playError) {
        console.error("Error trying to play outputMediaElement:", playError);
        this.updateError('Could not play audio. User interaction might be needed.');
      }
    }
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
    console.log('Audio system initialized for playback.');
  }

  private async initClient() {
    this.updateStatus('Initializing client...');
    this.initAudio();

    this.client = new GoogleGenAI({
      apiKey: process.env.API_KEY,
    });

    // --- START: Speaker Output Setup ---
    if (!this.outputMediaElement) { // Create only if it doesn't exist
        this.outputMediaElement = new Audio();
        this.outputMediaElement.autoplay = true; // Autoplay might be restricted
        // For debugging:
        // this.outputMediaElement.controls = true;
        // document.body.appendChild(this.outputMediaElement);
        console.log('Output HTMLAudioElement created.');
    }


    if (!this.mediaStreamDestination) { // Create only if it doesn't exist
        this.mediaStreamDestination = this.outputAudioContext.createMediaStreamDestination();
        console.log('MediaStreamAudioDestinationNode created.');
    }

    // Ensure outputNode is connected to mediaStreamDestination
    // Disconnect old connections first if any (though typically not needed on first init)
    try {
        this.outputNode.disconnect();
    } catch (e) { /* ignore if not connected */ }
    this.outputNode.connect(this.mediaStreamDestination);
    console.log('OutputNode connected to MediaStreamDestination.');

    if (this.outputMediaElement.srcObject !== this.mediaStreamDestination.stream) {
        this.outputMediaElement.srcObject = this.mediaStreamDestination.stream;
        console.log('outputMediaElement.srcObject set to MediaStreamDestination stream.');
    }


    if (typeof this.outputMediaElement.setSinkId === 'function') {
      try {
        await this.outputMediaElement.setSinkId(''); // '' for default media output
        console.log('Successfully set audio output sink to default (likely speaker).');
        this.updateStatus('Audio output configured for speaker.');
      } catch (err) {
        console.error('Error setting sinkId:', err);
        this.updateError(`Speaker setup: ${err.message}. May use earpiece.`);
      }
    } else {
      console.warn('setSinkId API not supported. Audio output will use default route.');
      this.updateStatus('Speaker setup: setSinkId not supported. Using default audio route.');
    }
    // --- END: Speaker Output Setup ---

    await this.initSession();
  }

  private async initSession() {
    this.updateStatus('Initializing AI session...');
    const model = 'gemini-2.5-flash-preview-native-audio-dialog';

    try {
      this.session = await this.client.live.connect({
        model: model,
        callbacks: {
          onopen: () => {
            console.log('AI session opened.');
            this.updateStatus('AI connected. ' + (this.error || 'Ready.'));
          },
          onmessage: async (message: LiveServerMessage) => {
            console.log('Message from server:', message);
            await this.resumeOutputAudio(); // Ensure audio can play

            const audio =
              message.serverContent?.modelTurn?.parts[0]?.inlineData;

            if (audio) {
              console.log('Received audio data from AI.');
              this.nextStartTime = Math.max(
                this.nextStartTime,
                this.outputAudioContext.currentTime,
              );

              const audioBuffer = await decodeAudioData(
                decode(audio.data),
                this.outputAudioContext,
                24000,
                1,
              );
              const source = this.outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              source.addEventListener('ended', () =>{
                this.sources.delete(source);
                console.log('AI audio source ended.');
              });

              source.start(this.nextStartTime);
              console.log(`AI audio scheduled to start at: ${this.nextStartTime}, duration: ${audioBuffer.duration}`);
              this.nextStartTime = this.nextStartTime + audioBuffer.duration;
              this.sources.add(source);
            }

            const interrupted = message.serverContent?.interrupted;
            if(interrupted) {
              console.warn('Server indicated an interruption. Stopping current AI audio playback.');
              for(const source of this.sources.values()) {
                source.stop(); // Stop immediately
                this.sources.delete(source);
              }
              this.nextStartTime = this.outputAudioContext.currentTime; // Reset start time for next AI audio
              this.updateStatus('Conversation interrupted by user.');
            }
          },
          onerror: (e: ErrorEvent) => {
            console.error('AI session error:', e);
            this.updateError(`AI session error: ${e.message}`);
          },
          onclose: (e: CloseEvent) => {
            console.log('AI session closed:', e);
            this.updateStatus(`AI session closed: ${e.reason || 'Unknown reason'}`);
            // Optionally, disable recording button if session closes unexpectedly
            // if (!this.isRecording) { // Or some other logic
            // this.isRecording = false; // Ensure UI reflects this
            // }
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Orus'}},
            // languageCode: 'en-GB'
            // TODO: Check Gemini API docs for interruption control parameters here
          },
        },
      });
      this.updateStatus('AI session configured.');
    } catch (e) {
      console.error('Failed to initialize AI session:', e);
      this.updateError(`AI session init failed: ${e.message}`);
    }
  }

  private updateStatus(msg: string) {
    console.log('Status:', msg);
    this.status = msg;
    this.error = ''; // Clear previous error when a new status comes
  }

  private updateError(msg: string) {
    console.error('Error:', msg);
    this.error = msg; // Display error
    // this.status = ''; // Optionally clear status when error occurs
  }

  private async startRecording() {
    if (this.isRecording) {
      return;
    }
    this.updateStatus('Starting recording...');
    this.error = ''; // Clear previous errors

    // Resume AudioContexts on user gesture - crucial for browsers
    if (this.inputAudioContext.state === 'suspended') {
      console.log('Input AudioContext is suspended, resuming...');
      await this.inputAudioContext.resume();
      console.log('Input AudioContext resumed. State:', this.inputAudioContext.state);
    }
    await this.resumeOutputAudio(); // Also ensure output audio path is ready

    this.updateStatus('Requesting microphone access...');
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
            // Optional: Add constraints if needed, e.g., echoCancellation: true
        },
        video: false,
      });
      console.log('Microphone access granted.');
      this.updateStatus('Microphone active. Starting capture...');

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 4096; // Increased buffer size for ScriptProcessorNode
                               // This might reduce load but increases latency.
                               // AudioWorklet is the proper long-term solution.
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording || !this.session || this.session.isClosed) { // Check session state
            if (this.session && this.session.isClosed) {
                console.warn("Session is closed, not sending audio.");
                this.stopRecording(); // Stop if session closed unexpectedly
            }
            return;
        }

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);

        try {
            this.session.sendRealtimeInput({media: createBlob(pcmData)});
        } catch (sendError) {
            console.error("Error sending realtime input:", sendError);
            this.updateError(`Send error: ${sendError.message}`);
            // Potentially stop recording or try to re-establish session if this error is persistent
        }
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      // Do NOT connect scriptProcessorNode to destination for raw input playback:
      // this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      this.isRecording = true;
      this.updateStatus('🔴 Recording...');
    } catch (err) {
      console.error('Error starting recording:', err);
      this.updateError(`Mic error: ${err.message}`);
      this.isRecording = false; // Ensure isRecording is false on error
      // this.stopRecording(); // Clean up if needed, though startRecording didn't fully complete
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream) { // Simpler check
        // If not recording and no media stream, likely already stopped or not started.
        // However, ensure UI consistency:
        if (this.isRecording) this.isRecording = false;
        return;
    }
    this.updateStatus('Stopping recording...');

    this.isRecording = false; // Set this first

    if (this.scriptProcessorNode) {
      this.scriptProcessorNode.disconnect();
      this.scriptProcessorNode.onaudioprocess = null; // Remove handler
      this.scriptProcessorNode = null;
      console.log('ScriptProcessorNode disconnected.');
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
      console.log('MediaStreamSourceNode disconnected.');
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
      console.log('MediaStream tracks stopped.');
    }

    // Optionally pause the output media element when not actively in a session
    // if (this.outputMediaElement && !this.outputMediaElement.paused) {
    //   this.outputMediaElement.pause();
    // }

    this.updateStatus('Recording stopped. Click Start to begin again.');
  }

  private async reset() {
    this.updateStatus('Resetting session...');
    this.stopRecording(); // Ensure recording is stopped first

    if (this.session && !this.session.isClosed) {
      this.session.close();
      console.log('Previous session closed.');
    }
    // Clear any pending audio sources
    for(const source of this.sources.values()) {
        try { source.stop(); } catch(e) {/* ignore */}
        this.sources.delete(source);
    }
    this.nextStartTime = 0;

    // Re-initialize client and session to ensure clean state,
    // including the audio output setup.
    try {
        await this.initClient(); // This will re-run the speaker setup and initSession
        this.updateStatus('Session reset and re-initialized.');
    } catch (err) {
        console.error("Reset failed:", err);
        this.updateError(`Reset failed: ${err.message}`);
    }
  }

  render() {
    return html`
      <div>
        <div class="controls">
          <button
            id="resetButton"
            @click=${this.reset}
            ?disabled=${this.isRecording}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="32px" viewBox="0 -960 960 960" width="32px" fill="#ffffff">
              <path
                d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z" />
            </svg>
          </button>
          <button
            id="startButton"
            @click=${this.startRecording}
            ?disabled=${this.isRecording}>
            <svg
              viewBox="0 0 100 100" width="32px" height="32px" fill="#c80000" xmlns="http://www.w3.org/2000/svg">
              <circle cx="50" cy="50" r="45" /> <!-- Slightly smaller circle -->
            </svg>
          </button>
          <button
            id="stopButton"
            @click=${this.stopRecording}
            ?disabled=${!this.isRecording}>
            <svg
              viewBox="0 0 100 100" width="32px" height="32px" fill="#ffffff" xmlns="http://www.w3.org/2000/svg">
              <rect x="15" y="15" width="70" height="70" rx="10" /> <!-- Adjusted square -->
            </svg>
          </button>
        </div>

        <div id="status"> ${this.error || this.status || 'Ready'} </div>
        <gdm-live-audio-visuals-3d
          .inputNode=${this.inputNode}
          .outputNode=${this.outputNode}></gdm-live-audio-visuals-3d>
      </div>
    `;
  }
}
