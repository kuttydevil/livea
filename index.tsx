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
  @state() status = '';
  @state() error = '';

  private client: GoogleGenAI;
  private session: Session;
  private inputAudioContext = new (window.AudioContext ||
    window.webkitAudioContext)({sampleRate: 16000});
  private outputAudioContext = new (window.AudioContext ||
    window.webkitAudioContext)({sampleRate: 24000}); // Consider latencyHint: 'playback'
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: AudioBufferSourceNode;
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();

  // New properties for speaker output
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

        &:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      }

      button[disabled] {
        display: none;
      }
    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initClient() {
    this.initAudio();

    this.client = new GoogleGenAI({
      apiKey: process.env.API_KEY,
    });

    // --- START: Speaker Output Setup ---
    this.outputMediaElement = new Audio();
    this.outputMediaElement.autoplay = true;
    // this.outputMediaElement.muted = true; // Keep unmuted, control volume via outputNode
    // this.outputMediaElement.controls = true; // For debugging, you can show controls
    // document.body.appendChild(this.outputMediaElement); // For debugging, append to see it

    this.mediaStreamDestination = this.outputAudioContext.createMediaStreamDestination();
    this.outputMediaElement.srcObject = this.mediaStreamDestination.stream;

    // Connect the main output gain node to our MediaStreamDestination
    // instead of the AudioContext's default destination.
    this.outputNode.connect(this.mediaStreamDestination);
    // DO NOT DO THIS ANYMORE: this.outputNode.connect(this.outputAudioContext.destination);

    // Attempt to set the audio output to the default speaker
    if (typeof this.outputMediaElement.setSinkId === 'function') {
      try {
        // '' (empty string) or 'default' often selects the main speaker for media.
        // On some systems, you might need to enumerate devices and pick a specific speaker ID.
        await this.outputMediaElement.setSinkId('');
        console.log('Successfully set audio output sink to default (likely speaker).');
        this.updateStatus('Audio output set to speaker.');
      } catch (err) {
        console.error('Error setting sinkId:', err);
        this.updateError(`Error setting audio output: ${err.message}. May use earpiece.`);
        // Fallback: if setSinkId fails, audio will play through the default route
        // which might still be the earpiece.
        // To ensure audio still plays, connect outputNode to default destination as a fallback.
        // However, this might create double audio if setSinkId partially worked or if the
        // mediaElement still plays. For now, let's assume if setSinkId fails, the
        // mediaElement route might still work via default routing.
      }
    } else {
      this.updateStatus('setSinkId API not supported. Audio output may use earpiece.');
      // If setSinkId is not supported, the audio from outputMediaElement will go to the
      // default device. To ensure our AudioContext output is heard, we could connect
      // outputNode to the default destination as well, but this could lead to double audio
      // if the media element also plays.
      // A safer fallback if setSinkId is not available is to just use the original method:
      // this.outputNode.connect(this.outputAudioContext.destination);
      // For now, we'll rely on the mediaElement's default routing.
    }
    // --- END: Speaker Output Setup ---

    this.initSession();
  }

  private async initSession() {
    const model = 'gemini-2.5-flash-preview-native-audio-dialog';

    try {
      this.session = await this.client.live.connect({
        model: model,
        callbacks: {
          onopen: () => {
            this.updateStatus('Opened. ' + (this.status || 'Audio output may use earpiece.'));
          },
          onmessage: async (message: LiveServerMessage) => {
            const audio =
              message.serverContent?.modelTurn?.parts[0]?.inlineData;

            if (audio) {
              // Ensure the output AudioContext is running, especially on user gesture
              if (this.outputAudioContext.state === 'suspended') {
                await this.outputAudioContext.resume();
              }
              // Ensure the media element is playing (important for some browsers)
              if (this.outputMediaElement.paused) {
                try {
                  await this.outputMediaElement.play();
                } catch (playError) {
                  console.error("Error trying to play outputMediaElement:", playError);
                  // This might happen if play() is called without prior user interaction
                  // on some strict mobile browsers.
                }
              }


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
              source.connect(this.outputNode); // outputNode is now connected to mediaStreamDestination
              source.addEventListener('ended', () =>{
                this.sources.delete(source);
              });

              source.start(this.nextStartTime);
              this.nextStartTime = this.nextStartTime + audioBuffer.duration;
              this.sources.add(source);
            }

            const interrupted = message.serverContent?.interrupted;
            if(interrupted) {
              for(const source of this.sources.values()) {
                source.stop();
                this.sources.delete(source);
              }
              this.nextStartTime = 0;
            }
          },
          onerror: (e: ErrorEvent) => {
            this.updateError(e.message);
          },
          onclose: (e: CloseEvent) => {
            this.updateStatus('Close:' + e.reason);
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Orus'}},
            // languageCode: 'en-GB'
          },
        },
      });
    } catch (e) {
      console.error(e);
      this.updateError(`Session init error: ${e.message}`);
    }
  }

  private updateStatus(msg: string) {
    this.status = msg;
  }

  private updateError(msg: string) {
    this.error = msg;
  }

  private async startRecording() {
    if (this.isRecording) {
      return;
    }

    // Resume AudioContexts on user gesture - crucial for browsers
    if (this.inputAudioContext.state === 'suspended') {
      await this.inputAudioContext.resume();
    }
    if (this.outputAudioContext.state === 'suspended') {
      await this.outputAudioContext.resume();
    }
    // Attempt to play the output media element on user gesture
    // This helps satisfy autoplay policies on mobile browsers.
    if (this.outputMediaElement && this.outputMediaElement.paused) {
        try {
            await this.outputMediaElement.play();
            console.log("Output media element played successfully on startRecording.");
        } catch (err) {
            console.warn("Could not play output media element on startRecording:", err);
            // This might still be okay if it plays when data arrives.
        }
    }


    this.updateStatus('Requesting microphone access...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      this.updateStatus('Microphone access granted. Starting capture...');

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 256; // Consider increasing if ScriptProcessorNode causes issues
                              // But ideally, move to AudioWorklet later.
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording) return;

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);

        this.session.sendRealtimeInput({media: createBlob(pcmData)});
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      // Do NOT connect scriptProcessorNode to destination if you don't want to hear raw input
      // this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      this.isRecording = true;
      this.updateStatus('🔴 Recording... Capturing PCM chunks.');
    } catch (err) {
      console.error('Error starting recording:', err);
      this.updateStatus(`Error: ${err.message}`);
      this.stopRecording();
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext)
      return;

    this.updateStatus('Stopping recording...');

    this.isRecording = false;

    if (this.scriptProcessorNode && this.sourceNode && this.inputAudioContext) {
      this.scriptProcessorNode.disconnect();
      this.sourceNode.disconnect();
    }

    this.scriptProcessorNode = null;
    this.sourceNode = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    // Optionally pause the output media element when not actively in a session
    // if (this.outputMediaElement && !this.outputMediaElement.paused) {
    //   this.outputMediaElement.pause();
    // }

    this.updateStatus('Recording stopped. Click Start to begin again.');
  }

  private reset() {
    this.session?.close();
    // Re-initialize client and session to ensure clean state,
    // including the audio output setup.
    // Or, more selectively, just re-init session if client setup is stable.
    // For simplicity here, re-running initClient will re-attempt setSinkId.
    this.initClient(); // This will re-run the speaker setup
    this.updateStatus('Session cleared.');
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
              height="40px"
              viewBox="0 -960 960 960"
              width="40px"
              fill="#ffffff">
              <path
                d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z" />
            </svg>
          </button>
          <button
            id="startButton"
            @click=${this.startRecording}
            ?disabled=${this.isRecording}>
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#c80000"
              xmlns="http://www.w3.org/2000/svg">
              <circle cx="50" cy="50" r="50" />
            </svg>
          </button>
          <button
            id="stopButton"
            @click=${this.stopRecording}
            ?disabled=${!this.isRecording}>
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#000000"
              xmlns="http://www.w3.org/2000/svg">
              <rect x="0" y="0" width="100" height="100" rx="15" />
            </svg>
          </button>
        </div>

        <div id="status"> ${this.status || this.error || 'Ready'} </div>
        <gdm-live-audio-visuals-3d
          .inputNode=${this.inputNode}
          .outputNode=${this.outputNode}></gdm-live-audio-visuals-3d>
      </div>
    `;
  }
}
