// interceptor.js — SignalR WebSocket Frame Interceptor (MAIN World)
// Monkey-patches the native WebSocket constructor to intercept Teams SignalR frames.
// Runs at document_start before Teams establishes connections.
// Dispatches TeamsMessageIntercepted CustomEvents for bridge.js to relay.

(function () {
  'use strict';

  const NativeWebSocket = window.WebSocket;
  const SIGNALR_SEPARATOR = '\u001e';

  // Self-detection: track the current user's sender ID to filter out own messages.
  // Learned from outgoing WebSocket send() calls or from Teams page globals.
  let selfUserId = null;
  let selfDisplayName = null;

  function detectSelfFromPageGlobals() {
    // Teams v2 stores user info in various global objects — try common locations
    try {
      // Try __NEXT_DATA__ (Teams v2 Next.js app)
      if (window.__NEXT_DATA__ && window.__NEXT_DATA__.props) {
        const user = window.__NEXT_DATA__.props.initialProps?.user;
        if (user && user.id) {
          selfUserId = user.id;
          selfDisplayName = user.displayName || null;
          console.log('Son of Claude [interceptor]: Self-detected from __NEXT_DATA__:', selfDisplayName || selfUserId);
          return;
        }
      }
    } catch (_) {}

    // Retry after Teams finishes loading
    setTimeout(detectSelfFromPageGlobals, 5000);
  }

  // Start self-detection attempts after a short delay (Teams needs to load)
  setTimeout(detectSelfFromPageGlobals, 3000);

  function isSelfMessage(senderId) {
    if (!senderId || !selfUserId) return false;
    // Compare normalized IDs (Teams IDs can have varying formats)
    return senderId === selfUserId || senderId.includes(selfUserId) || selfUserId.includes(senderId);
  }

  function tryParseSignalRFrames(data) {
    if (typeof data !== 'string') return;

    const segments = data.split(SIGNALR_SEPARATOR);
    for (const segment of segments) {
      if (!segment) continue;

      let parsed;
      try {
        parsed = JSON.parse(segment);
      } catch (_) {
        continue;
      }

      // Skip heartbeats (type 6)
      if (parsed.type === 6) continue;

      // Only process Invocations (type 1)
      if (parsed.type !== 1) continue;

      if (!parsed.arguments || !Array.isArray(parsed.arguments)) continue;

      for (const arg of parsed.arguments) {
        try {
          processArgument(arg);
        } catch (_) {
          // Silent fail — never disrupt Teams
        }
      }
    }
  }

  function processArgument(arg) {
    if (!arg || arg.resourceType !== 'NewMessage') return;

    const resource = arg.resource;
    if (!resource) return;

    // Skip system events
    if (resource.messageType === 'systemEventMessage') return;

    // Skip read receipts
    if (resource.messageReference) return;

    const messageText = resource.content || resource.messageText;
    if (!messageText) return;

    const from = resource.from;
    if (!from || !from.displayName) return;

    const sender = from.displayName;
    const senderId = from.id || null;
    const conversationId = resource.conversationLink || resource.to || null;
    const replyToId = resource.replyToId || null;

    // Filter out messages from self (own messages echoed back via WebSocket)
    if (isSelfMessage(senderId)) {
      console.log('Son of Claude [interceptor]: Filtered self-message from', sender);
      return;
    }

    console.log('Son of Claude [interceptor]: Message captured from', sender);

    window.dispatchEvent(new CustomEvent('TeamsMessageIntercepted', {
      detail: {
        sender,
        senderId,
        text: messageText,
        conversationId,
        replyToId,
        timestamp: Date.now()
      }
    }));
  }

  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args) {
      const ws = new target(...args);

      // Intercept send() to learn the current user's identity from outgoing messages
      const nativeSend = ws.send.bind(ws);
      ws.send = function (data) {
        if (!selfUserId && typeof data === 'string') {
          try {
            const segments = data.split(SIGNALR_SEPARATOR);
            for (const seg of segments) {
              if (!seg) continue;
              const parsed = JSON.parse(seg);
              // Outgoing messages contain the sender's own identity
              if (parsed.arguments && Array.isArray(parsed.arguments)) {
                for (const arg of parsed.arguments) {
                  const from = arg?.resource?.from || arg?.from;
                  if (from && from.id) {
                    selfUserId = from.id;
                    selfDisplayName = from.displayName || null;
                    console.log('Son of Claude [interceptor]: Self-ID learned from outgoing message:', selfDisplayName || selfUserId);
                    break;
                  }
                }
              }
            }
          } catch (_) {
            // Silent — never disrupt outgoing messages
          }
        }
        return nativeSend(data);
      };

      const nativeAddEventListener = ws.addEventListener.bind(ws);

      ws.addEventListener = function (type, listener, options) {
        if (type === 'message' && typeof listener === 'function') {
          const wrappedListener = function (event) {
            try {
              tryParseSignalRFrames(event.data);
            } catch (_) {
              // Silent fail — never disrupt Teams
            }
            // Always pass the original, unmodified event to Teams
            listener.call(this, event);
          };
          return nativeAddEventListener(type, wrappedListener, options);
        }
        return nativeAddEventListener(type, listener, options);
      };

      // Also intercept onmessage setter for completeness
      let _onmessage = null;
      Object.defineProperty(ws, 'onmessage', {
        get() { return _onmessage; },
        set(handler) {
          _onmessage = handler;
          nativeAddEventListener('message', function (event) {
            try {
              tryParseSignalRFrames(event.data);
            } catch (_) {
              // Silent fail
            }
            if (typeof handler === 'function') {
              handler.call(ws, event);
            }
          });
        },
        configurable: true,
        enumerable: true
      });

      return ws;
    },

    get(target, prop, receiver) {
      // Preserve prototype chain and static properties
      if (prop === 'prototype') return target.prototype;
      if (prop === Symbol.hasInstance) return (instance) => instance instanceof NativeWebSocket;
      return Reflect.get(target, prop, receiver);
    }
  });

  // Preserve instanceof checks
  Object.defineProperty(window.WebSocket, 'prototype', {
    value: NativeWebSocket.prototype,
    writable: false,
    configurable: false
  });

  console.log('Son of Claude [interceptor]: WebSocket proxy installed');
})();
