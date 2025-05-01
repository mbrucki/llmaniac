/**
 * llmaniac Client Library (Universal)
 *
 * Purpose: Handles integration with the llmaniac classification service.
 *          Listens for chat messages either via the standard `llmChatLogEvent`
 *          or via platform-specific APIs (Intercom, Drift, Zendesk Classic)
 *          based on configuration.
 *          Sends messages to the llmaniac API and either pushes results to dataLayer
 *          or sends them to the parent window via postMessage based on config.
 *
 * This script is intended to be loaded dynamically by a small loader snippet.
 * It relies on configuration passed via `window.llmaniacConfig`.
 */
(function(window, document) {
    'use strict';

    // Define the default configuration
    const defaultConfig = {
        apiUrl: 'https://llmaniac-249969218520.europe-central2.run.app/classify',
        logLevel: 'info', // Options: 'debug', 'info', 'warn', 'error', 'none'
        enableDataLayerPush: true,
        customEventName: null,
        chatPlatform: 'standard', // Options: 'standard', 'intercom', 'drift', 'zendesk'
        containerId: null,
        sendViaPostMessage: false,
        parentOrigin: null,
        sessionId: null // Will be auto-generated if not provided
    };

    // Merge default config with user-provided config
    const config = { ...defaultConfig, ...(window.llmaniacConfig || {}) };

    // Initialize or expose the llmaniac global object
    window.llmaniac = window.llmaniac || {};

    // Function to generate a UUID for session tracking
    function generateUUID() {
        // Simple UUID generator
        return 'xxxx-xxxx-xxxx-xxxx'.replace(/[x]/g, function(c) {
            const r = Math.random() * 16 | 0;
            return r.toString(16);
        });
    }

    // Session management functions
    window.llmaniac.resetSession = function() {
        const newSessionId = generateUUID();
        localStorage.setItem('llmaniac_session_id', newSessionId);
        if (config.logLevel === 'debug') {
            console.debug(`[llmaniac] Session reset, new sessionId: ${newSessionId}`);
        }
        return newSessionId;
    };

    window.llmaniac.getSessionId = function() {
        return localStorage.getItem('llmaniac_session_id');
    };

    window.llmaniac.setSessionId = function(customSessionId) {
        if (customSessionId) {
            localStorage.setItem('llmaniac_session_id', customSessionId);
            if (config.logLevel === 'debug') {
                console.debug(`[llmaniac] Session ID manually set to: ${customSessionId}`);
            }
            return true;
        }
        return false;
    };

    // Initialize or get the session ID
    function initializeSessionId() {
        // If config contains a sessionId, use that as priority
        if (config.sessionId) {
            localStorage.setItem('llmaniac_session_id', config.sessionId);
            return config.sessionId;
        }
        
        // Check if a session ID already exists in localStorage
        let sessionId = localStorage.getItem('llmaniac_session_id');
        
        // If not, generate a new one
        if (!sessionId) {
            sessionId = generateUUID();
            localStorage.setItem('llmaniac_session_id', sessionId);
            if (config.logLevel === 'debug') {
                console.debug(`[llmaniac] New session created: ${sessionId}`);
            }
        } else if (config.logLevel === 'debug') {
            console.debug(`[llmaniac] Using existing session: ${sessionId}`);
        }
        
        return sessionId;
    }

    // --- Logging Utility ---
    const logLevels = { 'debug': 1, 'info': 2, 'warn': 3, 'error': 4, 'none': 5 };
    const currentLogLevel = logLevels[config.logLevel] || logLevels.info;

    function log(level, ...args) {
        if (logLevels[level] >= currentLogLevel) {
            const platformTag = config.chatPlatform !== 'standard' ? config.chatPlatform.toUpperCase() : 'Standard';
            console[level === 'debug' ? 'log' : level](`[llmaniac-client/${platformTag}]`, ...args);
        }
    }

    // --- Core Functions ---

    // Function to handle sending data either via postMessage or dataLayer push
    function dispatchClassificationResult(classificationData) {
        if (!classificationData.shouldPush || !classificationData.event) {
             log('debug', 'Classification result condition not met (shouldPush=false or no event). Skipping dispatch.');
             return; // Exit if conditions aren't met
        }

        // Check for and perform postMessage if enabled
        if (config.sendViaPostMessage) {
            if (!config.parentOrigin) {
                log('error', 'sendViaPostMessage is true, but parentOrigin is not configured. Cannot send message.');
            } else {
                log('debug', 'Sending classification result via postMessage to parent.');
                const messagePayload = {
                    type: 'llmaniacClassification', // Standardized type for listener
                    data: {
                        event: classificationData.event,
                        confidence: classificationData.confidence,
                        sender: classificationData.sender,
                        containerId: config.containerId,
                        chat_platform: config.chatPlatform
                        // Include any other relevant fields from classificationData if needed
                    }
                };
                try {
                    window.parent.postMessage(messagePayload, config.parentOrigin);
                    log('info', 'Sent classification data to parent window:', messagePayload);
                } catch (error) {
                    log('error', 'Failed to send message to parent window. Check parentOrigin configuration and CORS policy.', error);
                }
            }
        }
        
        // Check for and perform dataLayer push if enabled (INDEPENDENTLY of postMessage)
        if (config.enableDataLayerPush) {
            pushToDataLayer(classificationData);
        }
    }

    function classifyWithLlmaniac(text, sender) {
        // Get the current session ID
        const sessionId = localStorage.getItem('llmaniac_session_id');
        
        if (config.logLevel === 'debug') {
            console.debug(`[llmaniac] Classifying message with sessionId: ${sessionId}`);
        }

        if (!text || !sender) {
            log('warn', 'Missing text or sender for classification.');
            return Promise.reject('Missing text or sender');
        }
        log('debug', `Classifying ${sender} message: ${text.substring(0, 50)}...`);

        // Prepare the request body
        const requestBody = {
            text: text,
            sender: sender,
            containerId: config.containerId,
            sessionId: sessionId // Include sessionId in every request
        };

        return fetch(config.apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(requestBody)
        })
        .then(response => {
            if (!response.ok) {
                log('error', `API request failed with status: ${response.status}`);
                // Try to parse error message from response body if possible
                return response.text().then(bodyText => {
                    log('error', 'API Error Response Body:', bodyText);
                    throw new Error(`HTTP error! status: ${response.status} - ${bodyText}`);
                }).catch(() => {
                    // If reading text fails, just throw the original status error
                    throw new Error(`HTTP error! status: ${response.status}`);
                });
            }
            return response.json();
        })
        // --- MODIFIED: Call dispatchClassificationResult after successful classification ---
        .then(classificationData => {
             log('info', 'Classification result:', classificationData);
             dispatchClassificationResult(classificationData); // Single point for handling result dispatch
             return classificationData; // Pass data along if needed for other .then() chains (though none exist here)
        })
        .catch(error => {
            log('error', 'API call or result dispatch failed:', error);
            // Don't re-throw here unless absolutely necessary,
            // prevents Promise rejection in the listener's chain unless critical.
            // throw error;
        });
    }


    function pushToDataLayer(classificationData) {
        // This function is now only called when config.sendViaPostMessage is false
        if (!config.enableDataLayerPush) {
             log('debug', 'enableDataLayerPush is false. Skipping dataLayer push.');
             return;
        }
        if (typeof window.dataLayer === 'undefined') {
            log('warn', 'dataLayer not found, cannot push event.');
            return;
        }

        log('debug', 'Pushing classification result directly to dataLayer.');

        // Zbieranie wspólnych właściwości
        const commonProperties = {
            confidence: classificationData.confidence,
            message_sender_type: classificationData.sender,
            llm_container_id: config.containerId,
            chat_platform: config.chatPlatform
            // Można dodać więcej wspólnych danych, jeśli potrzeba
        };

        // Budowanie payloadu dla dataLayer
        const dataLayerPayload = {
            'event': 'llmaniac_event',       // <<< Zmieniono na stałą nazwę
            'action': classificationData.event, // <<< Dodano nazwę eventu jako action
            ...commonProperties                // <<< Dodano resztę właściwości
        };

        // Perform the actual push
        try {
             window.dataLayer.push(dataLayerPayload);
             log('info', 'Pushed standardized event to dataLayer:', dataLayerPayload);
        } catch (e) {
             log('error', 'Error pushing to dataLayer:', e);
        }
    }


    // --- Platform-Specific Integration Logic ---
    // REMOVED pushToDataLayer calls from individual handlers,
    // classifyWithLlmaniac now handles dispatching via dispatchClassificationResult

    // Standard Event Listener
    function initializeStandardEventListener() {
        document.addEventListener(config.customEventName, (event) => {
            const messageData = event.detail;
            log('debug', 'Received standard event:', config.customEventName, messageData);
            if (!messageData || !messageData.text || !messageData.sender || !['human', 'ai'].includes(messageData.sender)) {
                log('warn', 'Invalid or incomplete standard event received (requires text, sender):', messageData);
                return;
            }
            // classifyWithLlmaniac now handles dispatching the result
            classifyWithLlmaniac(messageData.text, messageData.sender);
        });
        log('info', `Standard Mode: Listening for ${config.customEventName} on document.`);
    }

    // Intercom Integration
    function initializeIntercomIntegration() {
        if (typeof Intercom === 'function' && Intercom.booted) {
            log('info', 'Intercom API ready. Setting up listeners.');
            Intercom('onMessageSent', function(messageContent) {
                log('debug', 'Intercom onMessageSent detected.');
                if (messageContent && typeof messageContent === 'string') {
                    // classifyWithLlmaniac now handles dispatching the result
                    classifyWithLlmaniac(messageContent, 'human');
                }
            });
            // Note: Listening for AI messages in Intercom via client-side API is difficult/unreliable
            log('warn', 'Intercom integration focuses on human messages due to client-side API limitations for AI messages.');
            log('info', 'Intercom listeners set up.');
        } else {
            log('debug', 'Intercom API not ready, retrying in 1 second...');
            setTimeout(initializeIntercomIntegration, 1000);
        }
    }

    // Drift Integration
    function initializeDriftIntegration() {
        function setupListeners(driftApi) {
            if (!driftApi) {
                log('error', 'Drift API object not available for listener setup.');
                return;
            }
            log('info', 'Drift API ready. Setting up listeners.');
            driftApi.on('message:sent', function(data) {
                log('debug', 'Drift message:sent detected.');
                if (data?.message?.body) {
                    // classifyWithLlmaniac now handles dispatching the result
                    classifyWithLlmaniac(data.message.body, 'human');
                }
            });
            driftApi.on('message', function(data) {
                log('debug', 'Drift message received detected.');
                // Try to determine if it's an AI/agent message
                const isAgent = data?.message?.authorType && data.message.authorType !== 'END_USER';
                if (data?.message?.body && isAgent) {
                     // classifyWithLlmaniac now handles dispatching the result
                     classifyWithLlmaniac(data.message.body, 'ai');
                } else if (data?.message?.body && !isAgent) {
                     log('debug', 'Ignoring Drift received message from END_USER (handled by message:sent).');
                }
            });
            log('info', 'Drift listeners set up.');
        }

        if (typeof drift !== 'undefined' && drift.api) {
            log('debug', 'Drift API already available.');
            setupListeners(drift.api);
        } else if (typeof drift !== 'undefined') {
            log('debug', 'Drift API not ready, waiting for ready event.');
            window.drift.on('ready', function(api) {
                log('debug', 'Drift API ready event fired.');
                setupListeners(api || window.drift.api);
            });
        } else {
            log('warn', 'Drift object not found. Cannot initialize Drift integration.');
        }
    }

    // Zendesk Chat (Classic) Integration
    function initializeZendeskIntegration() {
        let lastVisitorMessage = ''; // Simple debounce/dedupe
        let lastAgentMessage = ''; // Simple debounce/dedupe

        if (typeof $zopim === 'function' && $zopim.livechat) {
            log('info', 'Zendesk API ($zopim) ready. Setting up listeners.');
            $zopim(function() {
                log('debug', 'Inside $zopim callback.');
                let visitorDisplayName = ''; // Try to get visitor name for better sender detection
                try {
                    visitorDisplayName = $zopim.livechat.visitor.getInfo()?.display_name;
                } catch (e) { log('warn', 'Could not get Zendesk visitor display name initially.', e); }

                $zopim.livechat.setOn('chat', function(event) {
                    if (event?.type === 'chat.msg' && event.msg) {
                        log('debug', 'Zendesk chat.msg detected:', event);

                        // Determine sender
                        let senderType = 'ai'; // Assume AI (agent) unless identified as visitor
                        // Check if display name matches visitor OR nick is 'visitor'
                        if ((visitorDisplayName && event.display_name === visitorDisplayName) || event.nick === 'visitor') {
                            senderType = 'human';
                        }

                        // Basic debounce to avoid duplicate processing if event fires multiple times
                        if (senderType === 'human' && event.msg === lastVisitorMessage) { log('debug','Debouncing duplicate human message'); return; }
                        if (senderType === 'ai' && event.msg === lastAgentMessage) { log('debug','Debouncing duplicate ai message'); return; }

                        // Update last message cache
                        if (senderType === 'human') { lastVisitorMessage = event.msg; lastAgentMessage = ''; } // Reset other cache
                        if (senderType === 'ai') { lastAgentMessage = event.msg; lastVisitorMessage = ''; } // Reset other cache

                        // classifyWithLlmaniac now handles dispatching the result
                        classifyWithLlmaniac(event.msg, senderType);
                    }
                });
                log('info', 'Zendesk listeners set up.');
            });
        } else {
            log('debug', 'Zendesk API ($zopim) not ready, retrying in 1 second...');
            setTimeout(initializeZendeskIntegration, 1000);
        }
    }

    // --- Initialization Router ---

    function initialize() {
        // Prevent double initialization
        if (window.llmaniacClientInitialized) {
            log('warn', 'llmaniac client already initialized. Skipping.');
            return;
        }
        window.llmaniacClientInitialized = true;
        log('info', 'Initializing llmaniac client with config:', config);

        // Initialize session ID management
        initializeSessionId();

        switch (config.chatPlatform) {
            case 'intercom':
                initializeIntercomIntegration();
                break;
            case 'drift':
                initializeDriftIntegration();
                break;
            case 'zendesk':
                initializeZendeskIntegration();
                break;
            case 'standard':
            default: // Fallback to standard if platform is unknown or 'standard'
                if (config.chatPlatform !== 'standard') {
                     log('warn', `Unknown chatPlatform '${config.chatPlatform}'. Falling back to 'standard'.`);
                }
                initializeStandardEventListener();
                break;
        }
    }

    // --- Auto-Initialization ---
    // Use a simple ready check or timeout to start initialization
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        document.addEventListener('DOMContentLoaded', initialize);
    }

})(window, document); 