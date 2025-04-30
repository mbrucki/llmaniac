/**
 * llmaniac Client Library (Universal)
 *
 * Purpose: Handles integration with the llmaniac classification service.
 *          Listens for chat messages either via the standard `llmChatLogEvent`
 *          or via platform-specific APIs (Intercom, Drift, Zendesk Classic)
 *          based on configuration.
 *          Sends messages to the llmaniac API and pushes results to dataLayer.
 *
 * This script is intended to be loaded dynamically by a small loader snippet.
 * It relies on configuration passed via `window.llmaniacConfig`.
 */
(function(window, document) {
    'use strict';

    // Default configuration
    const defaultConfig = {
        apiUrl: 'https://llmaniac-249969218520.europe-central2.run.app/classify',
        logLevel: 'info', // 'debug', 'info', 'warn', 'error', 'none'
        enableDataLayerPush: true,
        customEventName: 'llmChatLogEvent', // Used only when chatPlatform is 'standard'
        chatPlatform: 'standard', // 'standard', 'intercom', 'drift', 'zendesk'
        containerId: 'llm-000' // Renamed from clientId
    };

    // Merge default config with user-provided config
    const config = { ...defaultConfig, ...(window.llmaniacConfig || {}) };

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

    function classifyWithLlmaniac(text, sender) {
        if (!text || !sender) {
            log('warn', 'Missing text or sender for classification.');
            return Promise.reject('Missing text or sender');
        }
        log('debug', `Classifying ${sender} message: ${text.substring(0, 50)}...`);

        return fetch(config.apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({
                text: text,
                sender: sender,
                containerId: config.containerId
            })
        })
        .then(response => {
            if (!response.ok) {
                log('error', `API request failed with status: ${response.status}`);
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json();
        })
        .catch(error => {
            log('error', 'API call failed:', error);
            throw error; // Re-throw error to be caught by caller
        });
    }

    function pushToDataLayer(classificationData) {
        if (!config.enableDataLayerPush || typeof window.dataLayer === 'undefined') {
            if (config.enableDataLayerPush) log('warn', 'dataLayer not found, cannot push event.');
            return;
        }

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

        window.dataLayer.push(dataLayerPayload);
        log('info', 'Pushed standardized event to dataLayer:', dataLayerPayload); // Zaktualizowano log
    }

    // --- Platform-Specific Integration Logic ---

    // Standard Event Listener
    function initializeStandardEventListener() {
        document.addEventListener(config.customEventName, (event) => {
            const messageData = event.detail;
            log('debug', 'Received standard event:', config.customEventName, messageData);
            if (!messageData || !messageData.text || !messageData.sender || !['human', 'ai'].includes(messageData.sender)) {
                log('warn', 'Invalid or incomplete standard event received (requires text, sender):', messageData);
                return;
            }
            classifyWithLlmaniac(messageData.text, messageData.sender)
                .then(classificationData => {
                    log('info', 'Classification result:', classificationData);
                    if (classificationData.shouldPush && classificationData.event) {
                        pushToDataLayer(classificationData);
                    }
                })
                .catch(error => log('debug', 'Skipping dataLayer push due to API error.'));
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
                    classifyWithLlmaniac(messageContent, 'human')
                        .then(classificationData => {
                            log('info', 'Classification result:', classificationData);
                            if (classificationData.shouldPush && classificationData.event) {
                                pushToDataLayer(classificationData);
                            }
                        })
                        .catch(error => log('debug', 'Skipping dataLayer push due to API error.'));
                }
            });
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
                    classifyWithLlmaniac(data.message.body, 'human')
                        .then(classificationData => {
                            log('info', 'Classification result:', classificationData);
                            if (classificationData.shouldPush && classificationData.event) {
                                pushToDataLayer(classificationData);
                            }
                        })
                        .catch(error => log('debug', 'Skipping dataLayer push due to API error.'));
                }
            });
            driftApi.on('message', function(data) {
                log('debug', 'Drift message received detected.');
                if (data?.message?.body && data?.message?.authorType && data.message.authorType !== 'END_USER') {
                    classifyWithLlmaniac(data.message.body, 'ai')
                        .then(classificationData => {
                            log('info', 'Classification result:', classificationData);
                            if (classificationData.shouldPush && classificationData.event) {
                                pushToDataLayer(classificationData);
                            }
                        })
                        .catch(error => log('debug', 'Skipping dataLayer push due to API error.'));
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
        let lastVisitorMessage = '';
        let lastAgentMessage = '';

        if (typeof $zopim === 'function' && $zopim.livechat) {
            log('info', 'Zendesk API ($zopim) ready. Setting up listeners.');
            $zopim(function() {
                log('debug', 'Inside $zopim callback.');
                let visitorDisplayName = '';
                try {
                    visitorDisplayName = $zopim.livechat.visitor.getInfo()?.display_name;
                } catch (e) { log('warn', 'Could not get Zendesk visitor display name initially.', e); }

                $zopim.livechat.setOn('chat', function(event) {
                    if (event?.type === 'chat.msg' && event.msg) {
                        log('debug', 'Zendesk chat.msg detected:', event);

                        // Determine sender
                        let senderType = 'ai';
                        if ((visitorDisplayName && event.display_name === visitorDisplayName) || event.nick === 'visitor') {
                            senderType = 'human';
                        }

                        // Basic debounce
                        if (senderType === 'human' && event.msg === lastVisitorMessage) return;
                        if (senderType === 'ai' && event.msg === lastAgentMessage) return;
                        if (senderType === 'human') lastVisitorMessage = event.msg;
                        if (senderType === 'ai') lastAgentMessage = event.msg;

                        classifyWithLlmaniac(event.msg, senderType)
                            .then(classificationData => {
                                log('info', 'Classification result:', classificationData);
                                if (classificationData.shouldPush && classificationData.event) {
                                    pushToDataLayer(classificationData);
                                }
                            })
                            .catch(error => log('debug', 'Skipping dataLayer push due to API error.'));
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
        // --- Zabezpieczenie przed podwójną inicjalizacją --- START
        if (window.llmaniacClientInitialized) {
            log('warn', 'llmaniac client already initialized. Skipping.');
            return;
        }
        // --- Zabezpieczenie przed podwójną inicjalizacją --- END

        if (!config.apiUrl || config.apiUrl === 'YOUR_LLMANIAC_CLASSIFY_API_URL') {
            log('error', 'llmaniac API URL is not configured correctly. Aborting initialization.');
            return;
        }
        if (!config.containerId) {
            log('error', 'llmaniac containerId is not configured. Aborting initialization.');
            return;
        }

        log('info', `Initializing llmaniac client. Config:`, config);

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
            default:
                initializeStandardEventListener();
                break;
        }

        // --- Zabezpieczenie przed podwójną inicjalizacją - ustawienie flagi --- START
        window.llmaniacClientInitialized = true;
        log('info', 'llmaniac client initialization complete.');
        // --- Zabezpieczenie przed podwójną inicjalizacją - ustawienie flagi --- END
    }

    // --- Start Initialization ---
    // Ensure DOM is ready (or wait if needed, although usually loaded later)
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }

})(window, document); 