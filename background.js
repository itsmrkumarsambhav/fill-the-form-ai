// Enable Side Panel to open when the extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// Listen for tab updates to handle automatic multi-page form filling

// ── Sidebar State Management ──
let isSidebarOpen = false;
let whatsappTabId = null;
let currentWaTrigger = 'Fill Form';

// Initialize storage state on background script load
checkIfSidebarIsOpen().then(isOpen => {
  isSidebarOpen = isOpen;
  chrome.storage.local.set({ isSidebarOpen: isOpen });
});

async function checkIfSidebarIsOpen() {
  if (chrome.runtime.getContexts) {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['SIDE_PANEL']
      });
      return contexts.length > 0;
    } catch (e) {
      console.warn("[AutoForm Background] Failed to query contexts:", e);
    }
  }
  return isSidebarOpen;
}

function broadcastSidebarState(isOpen) {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { action: 'sidebar_state', isOpen: isOpen }).catch(() => {});
    });
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidebar') {
    isSidebarOpen = true;
    chrome.storage.local.set({ isSidebarOpen: true });
    broadcastSidebarState(true);
    
    // Inject File Injector (Magic Upload) into all existing tabs immediately
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        if (tab.url && !tab.url.startsWith('chrome://')) {
          chrome.scripting.executeScript({
              target: {tabId: tab.id, allFrames: true},
              files: ['static/cropper.min.js', 'static/jspdf.umd.min.js', 'static/pdf.min.js', 'file_injector.js']
          }).catch(() => {});
        }
      });
    });

    port.onDisconnect.addListener(() => {
      isSidebarOpen = false;
      chrome.storage.local.set({ isSidebarOpen: false });
      broadcastSidebarState(false);
    });
  }
});
// ────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Execute when the page has finished loading
  if (changeInfo.status === 'complete' && tab.url) {
    
    // Inject File Injector (Magic Upload) if sidebar is open
    checkIfSidebarIsOpen().then(sidebarOpen => {
        if (sidebarOpen && !tab.url.startsWith('chrome://')) {
            chrome.scripting.executeScript({
                target: {tabId: tabId, allFrames: true},
                files: ['static/cropper.min.js', 'static/jspdf.umd.min.js', 'static/pdf.min.js', 'file_injector.js']
            }).catch(() => {});
        }
    });

    chrome.storage.local.get(['autofillActive', 'autofillData', 'autofillFields', 'targetDomain'], (result) => {
      if (result.autofillActive && result.targetDomain) {
        try {
          const urlObj = new URL(tab.url);
          const currentDomain = urlObj.hostname;
          const targetDomain = result.targetDomain;

          // Check if current tab is on the same target domain (e.g. proteantech.in)
          const isCorrectSite = currentDomain === targetDomain || 
                                currentDomain.endsWith('.' + targetDomain) || 
                                targetDomain.endsWith('.' + currentDomain);

          if (isCorrectSite) {
            console.log("[AutoForm Background] Page load complete. Auto-injecting content script on tab:", tabId);

            // Bug fix: Inject field_dictionary.js FIRST so FIELD_DICTIONARY global exists
            // when content.js runs smartFillPage(). Without this, local dictionary matching
            // was silently skipped on every auto-fill triggered by page navigation.
            chrome.scripting.executeScript({
              target: { tabId: tabId, allFrames: true },
              files: ['field_dictionary.js']
            }, () => {
              if (chrome.runtime.lastError) {
                console.warn("[AutoForm Background] field_dictionary.js injection failed:", chrome.runtime.lastError.message);
              }
              chrome.scripting.executeScript({
                target: { tabId: tabId, allFrames: true },
                files: ['content.js']
              }, () => {
                if (chrome.runtime.lastError) {
                  console.warn("[AutoForm Background] Script injection failed:", chrome.runtime.lastError.message);
                  return;
                }

                // Bug fix: Increased from 150ms → 800ms.
                // On heavy government websites, the injected scripts take longer to parse
                // and register their chrome.runtime.onMessage listener. Messages sent too
                // early were silently dropped before the listener was ready.
                setTimeout(() => {
                  chrome.tabs.sendMessage(tabId, {
                    action: 'autofill',
                    data: result.autofillData,
                    fields: result.autofillFields
                  }, (response) => {
                    if (chrome.runtime.lastError) {
                      console.log("[AutoForm Background] Message failed (normal if page unloaded):", chrome.runtime.lastError.message);
                    } else if (response && response.success) {
                      console.log("[AutoForm Background] Dynamic fill completed successfully on tab:", tabId);
                    }
                  });
                }, 800);
              });
            });
          }
        } catch (e) {
          // Ignore invalid URLs like chrome://
        }
      }
    });
  }
});

// ==========================================
// CONTEXT MENU (RIGHT-CLICK) CAPTCHA SOLVER
// ==========================================
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "autoform_solve_captcha",
        title: "🧩 Form BharDo.AI - Solve CAPTCHA Here",
        contexts: ["page", "image", "selection"]
    });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "autoform_solve_captcha") {
        if (!tab || !tab.id) return;
        
        // 1. Ask content.js to find the CAPTCHA image on the page
        chrome.tabs.sendMessage(tab.id, { action: 'find_captcha' }, async (res) => {
            if (chrome.runtime.lastError || !res || !res.success) {
                chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (msg) => alert("AutoForm Error: " + msg), args: [res ? res.error : "CAPTCHA nahi mila."] });
                return;
            }

            // 2. Fetch User API Keys from local storage
            let userKeys = [];
            try {
                const storageRes = await new Promise(resolve => chrome.storage.local.get(['autoform_user_keys'], resolve));
                if (storageRes.autoform_user_keys) {
                    userKeys = JSON.parse(storageRes.autoform_user_keys).map(k => k.key);
                }
            } catch (e) { console.error("Error fetching keys:", e); }

            // 3. Solve CAPTCHA using Gemini API
            const parts = [
                { text: "Identify the CAPTCHA text or code in this image. Return ONLY the alphanumeric code characters with correct casing, nothing else. No explanation, no intro, no comments." },
                { inlineData: { mimeType: 'image/png', data: res.base64.split(',')[1] } }
            ];
            
            let solvedCode = null;
            try {
                const solved = await callGeminiRawText(userKeys, parts);
                solvedCode = solved.trim();
            } catch (e) { 
                console.warn("Backend Proxy failed for context menu CAPTCHA:", e); 
            }

            if (!solvedCode) {
                chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => alert("AutoForm Error: CAPTCHA solve karne me AI fail ho gaya.") });
                return;
            }

            // 4. Ask content.js to fill the solved code
            chrome.tabs.sendMessage(tab.id, { action: 'fill_captcha', code: solvedCode }, (fillRes) => {
                if (chrome.runtime.lastError || !fillRes || !fillRes.success) {
                    chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (msg) => alert("AutoForm Error: " + msg), args: [fillRes ? fillRes.error : "CAPTCHA input box nahi mila."] });
                }
            });
        });
    }
});
// ==========================================

// ==========================================
// SERVERLESS GEMINI API ENGINE (VIA RENDER PROXY)
// ==========================================

// TODO: Replace with your actual Render URL after deploying
const RENDER_BACKEND_URL = "https://your-app-name.onrender.com"; 

async function callGeminiRawText(userKeys, parts) {
    const url = `${RENDER_BACKEND_URL}/api/gemini/raw`;
    const payload = { parts: parts, userKeys: userKeys || [] };
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error("API Error: " + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.text;
}

async function callGemini(userKeys, parts) {
    const url = `${RENDER_BACKEND_URL}/api/gemini/json`;
    const payload = { parts: parts, userKeys: userKeys || [] };
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error("API Error: " + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'get_sidebar_state') {
        checkIfSidebarIsOpen().then(isOpen => {
            sendResponse({ isOpen: isOpen });
        });
        return true;
    }

    if (request.action === 'API_SOLVE_CAPTCHA') {
        (async () => {
            const parts = [
                { text: "Identify the CAPTCHA text or code in this image. Return ONLY the alphanumeric code characters with correct casing, nothing else. No explanation, no intro, no comments." },
                { inlineData: { mimeType: request.mimeType, data: request.base64Data } }
            ];
            const userKeys = Array.isArray(request.userApiKeys) ? request.userApiKeys : [];
            try {
                const solved = await callGeminiRawText(userKeys, parts);
                sendResponse({ success: true, code: solved.trim() });
            } catch (e) { 
                console.warn("Backend Proxy failed:", e); 
                sendResponse({ success: false, error: e.message || "All API keys failed." });
            }
        })();
        return true; 
    }

    if (request.action === 'API_EXTRACT_UNIVERSAL') {
        (async () => {
            try {
                const prompt = `You are an expert Indian document reader and data extractor.
Analyze the provided inputs carefully and extract as much personal information as possible.

Return a single flat JSON object. It MUST include these standard keys (use empty string "" if not found), AND you MUST also add any additional keys in lower_snake_case for ANY extra information found in the inputs that is not covered by the standard keys below:

PERSONAL:
- applicant_name        : Full name (English)
- applicant_name_hindi  : Full name (Hindi/Devanagari)
- first_name            : First name only
- middle_name           : Middle name only
- last_name             : Last name / Surname
- dob                   : Date of birth (DD/MM/YYYY)
- age                   : Age in years
- gender                : Male / Female / Third Gender
- salutation            : Mr / Mrs / Ms / Dr / Shri / Shrimati
- nationality           : Nationality (usually "Indian")
- marital_status        : Married / Unmarried / Widowed

FAMILY:
- father_name           : Father's full name (English)
- father_name_hindi     : Father's name (Hindi)
- father_first_name     : Father's first name
- father_middle_name    : Father's middle name
- father_last_name      : Father's last name
- mother_name           : Mother's full name (English)
- mother_name_hindi     : Mother's name (Hindi)
- mother_first_name     : Mother's first name
- mother_middle_name    : Mother's middle name
- mother_last_name      : Mother's last name
- husband_name          : Husband's full name (English)
- husband_name_hindi    : Husband's name (Hindi)
- guardian_name         : Guardian's name

CONTACT:
- mobile                : Mobile / phone number (10 digits)
- alternate_mobile      : Alternate mobile number
- email                 : Email address

IDENTITY DOCUMENTS:
- aadhaar               : Aadhaar number as 12 contiguous digits (no spaces/hyphens)
- aadhaar_no_1          : First 8 digits of Aadhaar
- aadhaar_no_2          : Last 4 digits of Aadhaar
- pan                   : PAN card number (10 chars e.g. ABCDE1234F)
- voter_id              : Voter ID / EPIC number
- driving_licence       : Driving licence number
- passport_number       : Passport number
- ration_card_number    : Ration card number

ADDRESS:
- state                 : State name (e.g. BIHAR, DELHI)
- district              : District name
- subdivision           : Sub-division / Anumandal
- block                 : Block / Tehsil / Taluka
- panchayat             : Gram Panchayat
- village               : Village / Town / Mohalla
- post_office           : Post Office name
- police_station        : Police Station / Thana
- pincode               : PIN code (6 digits)
- address               : Full address string
- flat_no               : Flat/House/Door number
- building_name         : Building/Premises name
- road_street           : Road/Street name
- area_locality         : Area/Locality/Colony
- city                  : City name
- ward_no               : Ward number
- holding_no            : Holding number
- circle_no             : Circle number
- assembly_constituency : Assembly / Vidhan Sabha constituency
- parliamentary_constituency : Lok Sabha / Parliamentary constituency

CASTE / CATEGORY:
- caste                 : Caste name
- sub_caste             : Sub-caste
- category              : SC / ST / OBC / EBC / General / UR
- religion              : Religion (Hindu / Muslim / Christian etc.)

INCOME / PROFESSION:
- profession            : Occupation / Job type
- annual_income         : Annual/total family income (number only)
- govt_income           : Income from government service
- business_income       : Income from business
- agri_income           : Income from agriculture
- other_income          : Income from other sources

BANK DETAILS:
- bank_account_number   : Bank account number
- bank_name             : Name of bank (e.g. State Bank of India)
- bank_ifsc             : IFSC code (e.g. SBIN0001234)
- bank_branch           : Branch name
- bank_holder_name      : Account holder name

OTHER:
- place_of_birth        : Place of birth
- blood_group           : Blood group (A+, B-, O+ etc.)
- school_college_name   : School/College/Institute name
- roll_number           : Roll/Registration number
- uan_number            : UAN number (EPFO)
- pf_account_number     : PF/EPF account number
- employer_name         : Employer/Company name
- khasra_number         : Khasra/Survey number (land)
- land_area             : Land area (bigha/hectare)
- voter_id              : Voter ID / EPIC card number
- local_body_type       : Type of local body (e.g. Gram Panchayat, Municipal Corporation, Municipality, Town Panchayat)
- residence_type        : Type of residence (e.g. Permanent, Temporary, स्थायी, अस्थायी)
- purpose_of_application : Purpose/reason for the application (e.g. government job, education, scholarship)
- proof_document_type   : Type of proof document selected (e.g. Ration Card, Voter ID, Revenue Record)
- self_declaration      : Whether user agrees to self declaration (yes/no/true/false)

IMPORTANT RULES:
1. Return ONLY raw JSON.
2. Aadhaar: return 12 contiguous digits, remove spaces and hyphens.
3. For Hindi fields: extract from document if visible, else transliterate.
4. If user-typed context or audio is provided, those OVERRIDE document data.
5. Priority: audio > typed context > document image.
6. Use empty string "" for any field not found in the standard list.
7. DEDUCTION RULE: You possess high logical deduction capabilities. If a required field is not explicitly stated but can be logically or mathematically derived from other provided data (e.g., calculating 'age' from 'dob', deducing 'gender' from 'salutation/Mr./Mrs.', or extracting first/last name from a full name), you MUST deduce and fill it.
8. NO HALLUCINATION: DO NOT fill in dummy data such as "John Doe", "Jane Doe", etc. If the audio is empty or does not contain a specific detail, return an empty string "" for that field.
9. FREEDOM TO ADD KEYS: If the user mentions ANY information not covered by the standard keys above (e.g. purpose_of_application, khasra_number, any custom field), you MUST add it as a new key in lower_snake_case. Do NOT ignore information just because it has no matching standard key.

User Context:
${request.userContext || 'None'}

Audio priority rules apply!
`;

                let finalPrompt = prompt;
                if (request.aiMode === 'chat') {
                    // Completely override the prompt for pure chat mode
                    finalPrompt = `You are a helpful, highly capable, and general-purpose AI assistant named Form BharDo.AI.
Your brain is fully open: you can answer any general questions, help with writing, code, general problems, analyze any uploaded images/documents (even if they are not personal ID documents), explain specifications, extract information, or just chat.
You have NO restrictions. Help the user with whatever they ask.
Respond in Hindi or English (Hinglish is preferred).

You MUST return your response in THIS EXACT JSON format:
{
  "profile": {},
  "feedback": "<Your detailed conversational response to the user. Use markdown if helpful.>"
}
Ensure the output is ONLY raw JSON.

User Message:
${request.userContext || 'None'}`;
                } else {
                    // Form extraction mode
                    if (request.formContextLabels && request.formContextLabels.length > 0) {
                        finalPrompt += `\n\nDYNAMIC FORM REQUIREMENTS:
The user is currently on a web form with the following empty field labels:
${request.formContextLabels.map(l => "- " + l).join("\n")}

CRITICAL INSTRUCTION — LABEL TO KEY MAPPING:
You are a multilingual semantic expert. For EACH label above, you MUST:

STEP 1: Understand the label's meaning — it may be in Hindi (Devanagari), English, Hinglish, or a mix.
STEP 2: Find the BEST MATCHING key from the fixed key list provided above in this prompt.
STEP 3: If the user's provided inputs contain that information, populate the EXISTING key with the value.
STEP 4: If NO existing key matches, create a new lower_snake_case key.

EXAMPLES OF SEMANTIC MATCHING (not exhaustive — use your intelligence for unlisted ones):
- "अभिवादन", "Salutation", "Title", "शीर्षक" → "salutation"
- "लिंग", "Gender", "Sex", "जेंडर" → "gender"
- "जन्म तिथि", "Date of Birth", "DOB", "जन्म दिनांक" → "dob"
- "आयु", "Age", "उम्र" → "age"
- "रक्त समूह", "Blood Group", "ब्लड ग्रुप" → "blood_group"
- "पिता का नाम", "Father's Name", "पिताजी का नाम" → "father_name"
- "माता का नाम", "Mother's Name", "माँ का नाम" → "mother_name"
- "पति का नाम", "Husband's Name" → "husband_name"
- "जाति", "Caste", "जात" → "caste"
- "उप-जाति", "Sub Caste" → "sub_caste"
- "श्रेणी", "Category", "वर्ग" → "category"
- "धर्म", "Religion", "मजहब" → "religion"
- "राष्ट्रीयता", "Nationality", "नागरिकता" → "nationality"
- "वैवाहिक स्थिति", "Marital Status" → "marital_status"
- "मोबाइल संख्या", "Mobile No", "फोन नंबर", "Contact No" → "mobile"
- "ईमेल", "Email", "ईमेल पता" → "email"
- "आधार संख्या", "Aadhaar Number", "आधार नंबर" → "aadhaar"
- "पैन", "PAN Number", "PAN Card" → "pan"
- "मतदाता पहचान पत्र", "Voter ID", "EPIC" → "voter_id"
- "राज्य", "State", "प्रान्त" → "state"
- "जिला", "District", "ज़िला" → "district"
- "अनुमंडल", "Sub-Division", "उप-प्रमंडल" → "subdivision"
- "प्रखंड", "Block", "तहसील", "Tehsil", "Taluka" → "block"
- "ग्राम पंचायत", "Gram Panchayat", "पंचायत" → "panchayat"
- "ग्राम", "Village", "मोहल्ला", "Mohalla", "Town" → "village"
- "डाक घर", "Post Office", "पोस्ट ऑफिस" → "post_office"
- "थाना", "Police Station", "पुलिस थाना" → "police_station"
- "पिन कोड", "PIN Code", "Pincode", "ZIP" → "pincode"
- "वार्ड संख्या", "Ward No", "Ward Number" → "ward_no"
- "पूरा पता", "Full Address", "Address" → "address"
- "मकान नंबर", "House No", "Flat No", "Door No" → "flat_no"
- "मार्ग", "Road", "Street", "गली" → "road_street"
- "क्षेत्र", "Locality", "Area", "Colony" → "area_locality"
- "शहर", "City", "नगर" → "city"
- "स्थानीय निकाय का प्रकार", "Type of Local Body" → "local_body_type"
- "निवास का प्रकार", "Type of Residence", "Residence Type" → "residence_type"
- "आवेदन का उद्देश्य", "Purpose", "Purpose of Application" → "purpose_of_application"
- "वार्षिक आय", "Annual Income", "आय" → "annual_income"
- "व्यवसाय", "Profession", "Occupation", "पेशा" → "profession"
- "बैंक खाता संख्या", "Account Number", "Bank Account" → "bank_account_number"
- "बैंक का नाम", "Bank Name" → "bank_name"
- "IFSC", "IFSC Code" → "bank_ifsc"
- "शाखा", "Branch", "Branch Name" → "bank_branch"
- "विद्यालय", "School", "College", "Institute Name" → "school_college_name"
- "रोल नंबर", "Roll Number", "Registration No" → "roll_number"
- "नियोक्ता", "Employer", "Company Name" → "employer_name"
- "जन्म स्थान", "Place of Birth", "Birthplace" → "place_of_birth"

RULES:
1. ONLY populate a key if the user's provided inputs actually contain that information.
2. NEVER put the label text itself as the value.
3. NEVER hallucinate or invent values not in the user's inputs.
4. If data is missing for any label, use empty string "".`;
                    }

                    if (request.chatMode) {
                        finalPrompt += `\n\nCHAT MODE ENABLED:
You are directly chatting with the user. You must return your response in THIS EXACT JSON format:
{
  "profile": { <the extracted fields as requested> },
  "feedback": "<Your conversational response to the user in Hindi/English. Let them know what you extracted or ask for missing details.>"
}
Ensure the output is ONLY raw JSON.`;
                    }
                }

                const parts = [{ text: finalPrompt }];
                
                if (request.audio) {
                    if (Array.isArray(request.audio)) {
                        request.audio.forEach(aud => {
                            parts.push({ inlineData: { mimeType: aud.mimeType, data: aud.base64 } });
                        });
                    } else {
                        parts.push({ inlineData: { mimeType: request.audio.mimeType, data: request.audio.base64 } });
                    }
                }
                if (request.images && request.images.length > 0) {
                    request.images.forEach(img => {
                        parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
                    });
                }

                const userKeys = Array.isArray(request.userApiKeys) ? request.userApiKeys : [];
                try {
                    const jsonRes = await callGemini(userKeys, parts);
                    
                    if (request.chatMode) {
                        const profileObj = jsonRes.profile || {};
                        const cleaned = {};
                        for (let k in profileObj) {
                            cleaned[k] = (profileObj[k] !== null && profileObj[k] !== undefined) ? String(profileObj[k]) : "";
                        }
                        sendResponse({ success: true, data: { profile: cleaned, feedback: jsonRes.feedback || "" } });
                    } else {
                        // Clean: convert all values to string
                        const cleaned = {};
                        for (let k in jsonRes) {
                            cleaned[k] = (jsonRes[k] !== null && jsonRes[k] !== undefined) ? String(jsonRes[k]) : "";
                        }
                        sendResponse({ success: true, data: cleaned });
                    }
                } catch (e) { 
                    console.warn("Backend Proxy failed:", e);
                    sendResponse({ success: false, error: e.message || "All API keys failed." });
                }
            } catch (err) {
                sendResponse({ success: false, error: err.toString() });
            }
        })();
        return true;
    }

    if (request.action === 'API_SMART_FILL') {
        (async () => {
            try {
                const prompt = `You are an expert form-filling AI with full reasoning capability.

USER PROFILE (all known data about this person):
${JSON.stringify(request.userProfile, null, 2)}

FORM FIELDS TO FILL (each has an id, a label, and sometimes a list of available options):
${JSON.stringify(request.emptyFields, null, 2)}

YOUR TASK:
For each field, use your reasoning to find the best matching value from the user profile.

RULES:
1. Return ONLY a flat JSON object. Keys = exact field "id". Values = what to fill.
2. For fields with "options" list: you MUST return the EXACT text of one of the given options (not a paraphrase). Use semantic understanding to pick the right one. Example: if profile says "B+" and options are ["A+","B+","O+"], return "B+".
3. For text fields: return the appropriate value from the profile directly.
4. For Hindi-labeled fields asking for Hindi text: transliterate English values to Devanagari. Example: "Ramesh Kumar" → "रमेश कुमार".
5. Use logical deduction: if profile says gender is "Male", salutation label is "अभिवादन" with options ["श्री","श्रीमती"], return "श्री".
6. If a field genuinely cannot be answered from the profile, return empty string "".
7. Do NOT wrap output in markdown. Return raw JSON only.`;

                const parts = [{ text: prompt }];
                const userKeys = Array.isArray(request.userApiKeys) ? request.userApiKeys : [];
                
                try {
                    const jsonRes = await callGemini(userKeys, parts);
                    sendResponse({ success: true, data: jsonRes });
                } catch (e) { 
                    console.warn("Backend Proxy Smart Fill failed:", e);
                    sendResponse({ success: false, error: e.message || "All API keys failed for Smart Fill." });
                }
            } catch (err) {
                sendResponse({ success: false, error: err.toString() });
            }
        })();
        return true;
    }

    if (request.action === 'process_offscreen_bg') {
        (async () => {
            try {
                console.log("[AutoForm Background] Setting up offscreen document...");
                await setupOffscreenDocument('offscreen.html');
                
                console.log("[AutoForm Background] Sending image to offscreen...");
                const response = await chrome.runtime.sendMessage({
                    action: 'offscreen_remove_bg',
                    imageData: request.imageData || request.dataUrl
                });
                
                console.log("[AutoForm Background] Received response from offscreen:", response);
                sendResponse(response);
            } catch (err) {
                console.error("[AutoForm Background] process_offscreen_bg failed:", err);
                sendResponse({ 
                    success: false, 
                    error: err.message || err.toString(),
                    name: err.name || "BackgroundError",
                    stack: err.stack 
                });
            }
        })();
        return true; // async response
    }

    if (request.action === 'start_whatsapp_monitor') {
        currentWaTrigger = request.trigger;
        
        // Find all WhatsApp tabs, pin the first one, and set the trigger on all of them
        try {
            chrome.tabs.query({ url: "*://web.whatsapp.com/*" }, (tabs) => {
                if (chrome.runtime.lastError) {
                    chrome.runtime.sendMessage({ action: 'whatsapp_log', log: '[Background] Query Error: ' + chrome.runtime.lastError.message }).catch(()=>{});
                    return;
                }

                if (tabs && tabs.length > 0) {
                    whatsappTabId = tabs[0].id;
                    chrome.runtime.sendMessage({ action: 'whatsapp_log', log: '[Background] Found WhatsApp tab. Pinning and activating...' }).catch(()=>{});
                    
                    chrome.tabs.update(whatsappTabId, { pinned: true }, () => {
                        if (chrome.runtime.lastError) {
                            chrome.runtime.sendMessage({ action: 'whatsapp_log', log: '[Background] Pinning failed: ' + chrome.runtime.lastError.message }).catch(()=>{});
                        }
                    });

                    // Send trigger to all matching tabs
                    tabs.forEach(tab => {
                        chrome.tabs.sendMessage(tab.id, { action: 'set_trigger', trigger: currentWaTrigger }).catch(()=>{});
                    });
                } else {
                    chrome.runtime.sendMessage({ action: 'whatsapp_log', log: '[Background] No WhatsApp tab found. Creating new pinned tab...' }).catch(()=>{});
                    chrome.tabs.create({ url: 'https://web.whatsapp.com', pinned: true, active: false }, (tab) => {
                        whatsappTabId = tab.id;
                    });
                }
            });
        } catch (e) {
            chrome.runtime.sendMessage({ action: 'whatsapp_log', log: '[Background] Query Exception: ' + e.message }).catch(()=>{});
        }
    }
    else if (request.action === 'stop_whatsapp_monitor') {
        chrome.tabs.query({ url: "*://web.whatsapp.com/*" }, (tabs) => {
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, { action: 'stop_monitor' }).catch(()=>{});
            });
        });
    }
    else if (request.action === 'get_whatsapp_trigger') {
        sendResponse({ trigger: currentWaTrigger });
    }
    else if (request.action === 'whatsapp_file_received') {
        // Only forward to active listeners (like popup), don't store offline anymore
    }
});

// ── Offscreen Document Management ──
async function setupOffscreenDocument(path) {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(path)]
  });

  if (existingContexts.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: path,
    reasons: ['DOM_PARSER'],
    justification: 'Run MediaPipe ML model for background removal securely'
  });
}
