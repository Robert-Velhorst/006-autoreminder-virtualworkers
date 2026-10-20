/**
 * @param {Document} document
 * @param {Window} window
 */
export function installCookieHelper(document, window) {
    const statusNode = document.getElementById('status');
    const clearNode = /** @type {HTMLButtonElement | null} */ (document.getElementById('clearBtn'));
    const goNode = /** @type {HTMLButtonElement | null} */ (document.getElementById('goBtn'));
    if (!statusNode || !clearNode || !goNode) throw new Error('Cookie helper controls are missing');
    const statusDiv = statusNode;
    const clearBtn = clearNode;
    const goBtn = goNode;

    /** @param {string} tag @param {string} [text] */
    function statusElement(tag, text) {
        const element = document.createElement(tag);
        if (text !== undefined) element.textContent = text;
        return element;
    }

    /** @param {HTMLElement} statusDiv @param {...(string | Node)} parts */
    function setStatus(statusDiv, ...parts) {
        statusDiv.replaceChildren(...parts.map(part =>
            typeof part === 'string' ? document.createTextNode(part) : part
        ));
    }

    function clearCookies() {
        try {
            // Get all cookies
            const cookies = document.cookie.split(";");
            let clearedCount = 0;

            // Clear each cookie
            cookies.forEach(cookie => {
                const eqPos = cookie.indexOf("=");
                const name = eqPos > -1 ? cookie.substr(0, eqPos).trim() : cookie.trim();
                
                // Clear for current path
                document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/";
                
                // Clear for root path
                document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;";
                
                // Clear with domain
                document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=" + window.location.hostname;
                
                clearedCount++;
            });

            // Check if we're on localhost:3001
            if (window.location.hostname === 'localhost' && window.location.port === '3001') {
                statusDiv.className = 'status success';
                setStatus(statusDiv,
                    `✅ Success! Cleared ${clearedCount} cookie(s).`, statusElement('br'),
                    'Click "Go to Dashboard" to test the login form.'
                );
                clearBtn.disabled = true;
                goBtn.disabled = false;
            } else {
                statusDiv.className = 'status error';
                setStatus(statusDiv,
                    '⚠️ Warning: This page is not opened from localhost:3001.', statusElement('br'),
                    `Current location: ${window.location.href}`, statusElement('br'), statusElement('br'),
                    'Please open this file at: ', statusElement('code', 'http://localhost:3001/clear-cookies.html')
                );
            }
        } catch (error) {
            statusDiv.className = 'status error';
            const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
            setStatus(statusDiv,
                `❌ Error clearing cookies: ${message}`, statusElement('br'),
                'Please use the manual method below.'
            );
        }
    }

    function goToDashboard() {
        window.location.href = '/';
    }

    // Check if we're on the right domain on page load
    window.addEventListener('load', () => {
        if (window.location.hostname !== 'localhost' || window.location.port !== '3001') {
            statusDiv.className = 'status error';
            setStatus(statusDiv,
                '⚠️ This page must be opened from the dev server!', statusElement('br'), statusElement('br'),
                statusElement('strong', 'Current location:'), ` ${window.location.href}`, statusElement('br'),
                statusElement('strong', 'Required location:'), ' ', statusElement('code', 'http://localhost:3001/clear-cookies.html'),
                statusElement('br'), statusElement('br'),
                'Please copy this file to ', statusElement('code', 'va-dashboard/client/public/'), ' and access it through the dev server.'
            );
            clearBtn.disabled = true;
        }
    });

    clearBtn.addEventListener('click', clearCookies);
    goBtn.addEventListener('click', goToDashboard);
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    installCookieHelper(document, window);
}
