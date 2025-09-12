require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// Bot configuration
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// Matrix Synapse configuration
const MATRIX_URL = process.env.MATRIX_URL;
const MATRIX_ADMIN_TOKEN = process.env.MATRIX_ADMIN_TOKEN;

// Security configuration
const AUTHORIZED_USERS = process.env.AUTHORIZED_USERS ? 
    process.env.AUTHORIZED_USERS.split(',').map(id => parseInt(id.trim())) : [];
const AUTHORIZED_USERNAMES = process.env.AUTHORIZED_USERNAMES ? 
    process.env.AUTHORIZED_USERNAMES.split(',').map(username => username.trim().toLowerCase()) : [];

// Store user states for multi-step operations
const userStates = new Map();

// Authorization functions
function isAuthorized(user) {
    // If no authorized users configured, deny all access for security
    if (AUTHORIZED_USERS.length === 0 && AUTHORIZED_USERNAMES.length === 0) {
        console.error('⚠️  No authorized users configured! Bot is locked down.');
        return false;
    }
    
    // Check user ID
    if (AUTHORIZED_USERS.includes(user.id)) {
        return true;
    }
    
    // Check username (case insensitive)
    if (user.username && AUTHORIZED_USERNAMES.includes(user.username.toLowerCase())) {
        return true;
    }
    
    return false;
}

function logUnauthorizedAccess(user, command) {
    const userInfo = `${user.first_name || ''} ${user.last_name || ''}`.trim();
    const username = user.username ? `@${user.username}` : 'no username';
    console.warn(`🚫 Unauthorized access attempt:`);
    console.warn(`   User: ${userInfo} (${username})`);
    console.warn(`   ID: ${user.id}`);
    console.warn(`   Command: ${command}`);
    console.warn(`   Time: ${new Date().toISOString()}`);
}

function sendUnauthorizedMessage(chatId) {
    const message = `🚫 *Access Denied*\n\nYou are not authorized to use this bot.\n\nThis bot is restricted to specific users only.\nIf you believe this is an error, contact the administrator.`;
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

function logAuthorizedAccess(user, command) {
    const userInfo = `${user.first_name || ''} ${user.last_name || ''}`.trim();
    const username = user.username ? `@${user.username}` : 'no username';
    console.log(`✅ Authorized access:`);
    console.log(`   User: ${userInfo} (${username})`);
    console.log(`   ID: ${user.id}`);
    console.log(`   Command: ${command}`);
    console.log(`   Time: ${new Date().toISOString()}`);
}

// Authorization middleware
function requireAuth(handler) {
    return (msg) => {
        const user = msg.from;
        const command = msg.text || 'callback';
        
        if (!isAuthorized(user)) {
            logUnauthorizedAccess(user, command);
            sendUnauthorizedMessage(msg.chat.id);
            return;
        }
        
        logAuthorizedAccess(user, command);
        handler(msg);
    };
}

function requireAuthCallback(handler) {
    return (callbackQuery) => {
        const user = callbackQuery.from;
        const command = `callback: ${callbackQuery.data}`;
        
        if (!isAuthorized(user)) {
            logUnauthorizedAccess(user, command);
            sendUnauthorizedMessage(callbackQuery.message.chat.id);
            bot.answerCallbackQuery(callbackQuery.id, { text: 'Access denied' });
            return;
        }
        
        logAuthorizedAccess(user, command);
        handler(callbackQuery);
    };
}

// Matrix API client
class MatrixClient {
    constructor(baseUrl, adminToken) {
        this.baseUrl = baseUrl;
        this.adminToken = adminToken;
        this.headers = {
            'Authorization': `Bearer ${adminToken}`,
            'Content-Type': 'application/json'
        };
    }

    async getUsers(from = 0, limit = 100) {
        try {
            const response = await axios.get(
                `${this.baseUrl}/_synapse/admin/v2/users`,
                {
                    headers: this.headers,
                    params: { from, limit }
                }
            );
            return response.data;
        } catch (error) {
            console.error('Error fetching users:', error.response?.data || error.message);
            throw new Error(`Failed to fetch users: ${error.response?.data?.error || error.message}`);
        }
    }

    async deactivateUser(userId) {
        try {
            const response = await axios.post(
                `${this.baseUrl}/_synapse/admin/v1/deactivate/${encodeURIComponent(userId)}`,
                { erase: false },
                { headers: this.headers }
            );
            return response.data;
        } catch (error) {
            console.error('Error deactivating user:', error.response?.data || error.message);
            throw new Error(`Failed to deactivate user: ${error.response?.data?.error || error.message}`);
        }
    }

    async searchUsers(searchTerm, from = 0, limit = 100) {
        try {
            // Get all users first (Matrix doesn't have built-in search)
            const response = await axios.get(
                `${this.baseUrl}/_synapse/admin/v2/users`,
                {
                    headers: this.headers,
                    params: { from: 0, limit: 1000 } // Get more users for search
                }
            );
            
            const allUsers = response.data.users || [];
            const searchLower = searchTerm.toLowerCase();
            
            // Filter users based on search term
            const filteredUsers = allUsers.filter(user => {
                return (
                    user.name.toLowerCase().includes(searchLower) ||
                    (user.displayname && user.displayname.toLowerCase().includes(searchLower)) ||
                    user.name === searchTerm // Exact match for user IDs
                );
            });
            
            // Apply pagination to filtered results
            const startIndex = from;
            const endIndex = Math.min(startIndex + limit, filteredUsers.length);
            const paginatedUsers = filteredUsers.slice(startIndex, endIndex);
            
            return {
                users: paginatedUsers,
                total: filteredUsers.length,
                from: from,
                limit: limit
            };
        } catch (error) {
            console.error('Error searching users:', error.response?.data || error.message);
            throw new Error(`Failed to search users: ${error.response?.data?.error || error.message}`);
        }
    }

    async getUserInfo(userId) {
        try {
            const response = await axios.get(
                `${this.baseUrl}/_synapse/admin/v2/users/${encodeURIComponent(userId)}`,
                { headers: this.headers }
            );
            return response.data;
        } catch (error) {
            console.error('Error getting user info:', error.response?.data || error.message);
            throw new Error(`Failed to get user info: ${error.response?.data?.error || error.message}`);
        }
    }
}

const matrixClient = new MatrixClient(MATRIX_URL, MATRIX_ADMIN_TOKEN);

// Utility functions
function createMainKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: '👥 Get All Users', callback_data: 'get_users' }],
                [{ text: '🔍 Search Users', callback_data: 'search_users' }],
                [{ text: '❌ Deactivate User', callback_data: 'deactivate_menu' }],
                [{ text: '🔒 Show My Info', callback_data: 'show_my_info' }]
            ]
        }
    };
}

function createUserSelectionKeyboard(users, page = 0, usersPerPage = 10, actionPrefix = 'deactivate') {
    const startIndex = page * usersPerPage;
    const endIndex = Math.min(startIndex + usersPerPage, users.length);
    const pageUsers = users.slice(startIndex, endIndex);
    
    const keyboard = [];
    
    // Add user buttons
    pageUsers.forEach(user => {
        const status = user.deactivated ? '❌' : '✅';
        const userType = user.admin ? ' 👑' : (user.user_type ? ` (${user.user_type})` : '');
        keyboard.push([{
            text: `${status} ${user.displayname || user.name}${userType}`,
            callback_data: `${actionPrefix}_${user.name}`
        }]);
    });
    
    // Add navigation buttons
    const navRow = [];
    if (page > 0) {
        navRow.push({ text: '◀️ Previous', callback_data: `${actionPrefix}_page_${page - 1}` });
    }
    if (endIndex < users.length) {
        navRow.push({ text: 'Next ▶️', callback_data: `${actionPrefix}_page_${page + 1}` });
    }
    if (navRow.length > 0) {
        keyboard.push(navRow);
    }
    
    // Add back button
    keyboard.push([{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]);
    
    return { reply_markup: { inline_keyboard: keyboard } };
}

function createSearchResultKeyboard(users, searchTerm, page = 0, usersPerPage = 10) {
    const startIndex = page * usersPerPage;
    const endIndex = Math.min(startIndex + usersPerPage, users.length);
    const pageUsers = users.slice(startIndex, endIndex);
    
    const keyboard = [];
    
    // Add user buttons with info and deactivate options
    pageUsers.forEach(user => {
        const status = user.deactivated ? '❌' : '✅';
        const userType = user.admin ? ' 👑' : (user.user_type ? ` (${user.user_type})` : '');
        
        let actionButton;
        if (user.deactivated) {
            actionButton = { text: '❌ Deactivated', callback_data: 'noop' };
        } else if (user.admin) {
            actionButton = { text: '👑 Admin Protected', callback_data: 'noop' };
        } else {
            actionButton = { text: '🗑️ Deactivate', callback_data: `deactivate_${user.name}` };
        }
        
        keyboard.push([
            { text: `${status} ${user.displayname || user.name}${userType}`, callback_data: `userinfo_${user.name}` },
            actionButton
        ]);
    });
    
    // Add navigation buttons
    const navRow = [];
    if (page > 0) {
        navRow.push({ text: '◀️ Previous', callback_data: `search_page_${page - 1}` });
    }
    if (endIndex < users.length) {
        navRow.push({ text: 'Next ▶️', callback_data: `search_page_${page + 1}` });
    }
    if (navRow.length > 0) {
        keyboard.push(navRow);
    }
    
    // Add search again and back buttons
    keyboard.push([
        { text: '🔍 New Search', callback_data: 'search_users' },
        { text: '🔙 Back to Menu', callback_data: 'back_to_menu' }
    ]);
    
    return { reply_markup: { inline_keyboard: keyboard } };
}

// Command handlers with authorization
bot.onText(/\/start/, requireAuth((msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;
    const userInfo = `${user.first_name || ''} ${user.last_name || ''}`.trim();
    
    const welcomeMessage = `
🤖 *Matrix Synapse Admin Bot*

Welcome, ${userInfo}!

This bot helps you manage your Matrix Synapse server.

Available actions:
• Get all users from the server
• Search for specific users
• Deactivate selected users
• View your authorization info

Choose an action from the menu below:
    `;
    
    bot.sendMessage(chatId, welcomeMessage, {
        parse_mode: 'Markdown',
        ...createMainKeyboard()
    });
}));

bot.onText(/\/help/, requireAuth((msg) => {
    const chatId = msg.chat.id;
    const helpMessage = `
📖 *Help - Matrix Synapse Admin Bot*

*Commands:*
• /start - Show main menu
• /help - Show this help message
• /menu - Return to main menu
• /whoami - Show your user info
• /search <term> - Quick search for users

*Features:*
• View all users on your Matrix server
• Search users by name, display name, or user ID
• Deactivate user accounts
• View detailed user information
• Paginated user lists for easy navigation
• Secure access control

*Search Tips:*
• Search by partial name: "john"
• Search by display name: "John Doe"
• Search by exact user ID: "@user:example.com"
• Case insensitive search

*Security:*
• Only authorized users can access this bot
• All access attempts are logged
• User authorization is checked for every action

*Requirements:*
• Bot must be configured with Matrix admin token
• You must have admin privileges on the Matrix server
• Your Telegram user ID or username must be in the authorized list
    `;
    
    bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
}));

bot.onText(/\/menu/, requireAuth((msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 'Choose an action:', createMainKeyboard());
}));

bot.onText(/\/whoami/, requireAuth((msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;
    const userInfo = `${user.first_name || ''} ${user.last_name || ''}`.trim();
    const username = user.username ? `@${user.username}` : 'No username';
    
    const message = `
🔒 *Your Authorization Info*

*Name:* ${userInfo}
*Username:* ${username}
*User ID:* \`${user.id}\`
*Language:* ${user.language_code || 'Unknown'}

✅ *Status:* Authorized
🔐 *Access Level:* Matrix Admin

*Note:* Your user ID or username is in the authorized list for this bot.
    `;
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}));

// Quick search command
bot.onText(/\/search (.+)/, requireAuth(async (msg, match) => {
    const chatId = msg.chat.id;
    const searchTerm = match[1].trim();
    
    const searchingMessage = await bot.sendMessage(chatId, `🔍 Searching for: "${searchTerm}"...`);
    
    try {
        const searchResults = await matrixClient.searchUsers(searchTerm);
        const users = searchResults.users || [];
        
        if (users.length === 0) {
            await bot.editMessageText(`🔍 *Search Results*\n\nNo users found matching: "${searchTerm}"\n\nTry searching with different terms.`, {
                chat_id: chatId,
                message_id: searchingMessage.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔍 New Search', callback_data: 'search_users' }],
                        [{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]
                    ]
                }
            });
            return;
        }
        
        // Store search results in user state
        userStates.set(chatId, { 
            search_results: users, 
            search_term: searchTerm,
            search_page: 0 
        });
        
        const resultMessage = `🔍 *Search Results*\n\nFound ${searchResults.total} users matching: "${searchTerm}"\n\nClick on a user to view details or deactivate:`;
        
        await bot.editMessageText(resultMessage, {
            chat_id: chatId,
            message_id: searchingMessage.message_id,
            parse_mode: 'Markdown',
            ...createSearchResultKeyboard(users, searchTerm, 0)
        });
        
    } catch (error) {
        await bot.editMessageText(`❌ *Search Failed*\n\nError: ${error.message}`, {
            chat_id: chatId,
            message_id: searchingMessage.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]]
            }
        });
    }
}));

// Text message handler for search input
bot.on('message', requireAuth(async (msg) => {
    // Skip if it's a command
    if (msg.text && msg.text.startsWith('/')) {
        return;
    }
    
    const chatId = msg.chat.id;
    const userState = userStates.get(chatId);
    
    // Check if user is in search input mode
    if (userState && userState.waiting_for_search) {
        const searchTerm = msg.text.trim();
        
        if (!searchTerm) {
            bot.sendMessage(chatId, '❌ Please enter a valid search term.');
            return;
        }
        
        const searchingMessage = await bot.sendMessage(chatId, `🔍 Searching for: "${searchTerm}"...`);
        
        try {
            const searchResults = await matrixClient.searchUsers(searchTerm);
            const users = searchResults.users || [];
            
            if (users.length === 0) {
                await bot.editMessageText(`🔍 *Search Results*\n\nNo users found matching: "${searchTerm}"\n\nTry searching with different terms.`, {
                    chat_id: chatId,
                    message_id: searchingMessage.message_id,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔍 New Search', callback_data: 'search_users' }],
                            [{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]
                        ]
                    }
                });
                
                // Clear search state
                userStates.delete(chatId);
                return;
            }
            
            // Update user state with search results
            userStates.set(chatId, { 
                search_results: users, 
                search_term: searchTerm,
                search_page: 0 
            });
            
            const resultMessage = `🔍 *Search Results*\n\nFound ${searchResults.total} users matching: "${searchTerm}"\n\nClick on a user to view details or deactivate:`;
            
            await bot.editMessageText(resultMessage, {
                chat_id: chatId,
                message_id: searchingMessage.message_id,
                parse_mode: 'Markdown',
                ...createSearchResultKeyboard(users, searchTerm, 0)
            });
            
        } catch (error) {
            await bot.editMessageText(`❌ *Search Failed*\n\nError: ${error.message}`, {
                chat_id: chatId,
                message_id: searchingMessage.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]]
                }
            });
            
            // Clear search state
            userStates.delete(chatId);
        }
    }
}));

// Callback query handler with authorization
bot.on('callback_query', requireAuthCallback(async (callbackQuery) => {
    const message = callbackQuery.message;
    const data = callbackQuery.data;
    const chatId = message.chat.id;
    const messageId = message.message_id;
    const user = callbackQuery.from;

    // Answer callback query immediately to prevent timeout
    try {
        await bot.answerCallbackQuery(callbackQuery.id);
    } catch (answerError) {
        console.error('Error answering callback query:', answerError.message);
    }

    try {
        if (data === 'show_my_info') {
            const userInfo = `${user.first_name || ''} ${user.last_name || ''}`.trim();
            const username = user.username ? `@${user.username}` : 'No username';
            
            const infoMessage = `
🔒 *Your Authorization Info*

*Name:* ${userInfo}
*Username:* ${username}
*User ID:* \`${user.id}\`

✅ *Status:* Authorized
🔐 *Access Level:* Matrix Admin
            `;
            
            await bot.editMessageText(infoMessage, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]]
                }
            });

        } else if (data === 'search_users') {
            await bot.editMessageText('🔍 *Search Users*\n\nPlease enter the search term (name, display name, or user ID):\n\nType your search query and send it as a message.', {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]
                    ]
                }
            });
            
            // Set user state to expect search input
            userStates.set(chatId, { waiting_for_search: true });

        } else if (data.startsWith('search_page_')) {
            const page = parseInt(data.split('_')[2]);
            const state = userStates.get(chatId);
            
            if (state && state.search_results) {
                state.search_page = page;
                userStates.set(chatId, state);
                
                await bot.editMessageReplyMarkup(
                    createSearchResultKeyboard(state.search_results, state.search_term, page).reply_markup,
                    { chat_id: chatId, message_id: messageId }
                );
            }

        } else if (data.startsWith('userinfo_')) {
            const userId = data.substring('userinfo_'.length);
            
            try {
                const userInfo = await matrixClient.getUserInfo(userId);
                
                const infoMessage = `
👤 *User Information*

*User ID:* \`${userInfo.name}\`
*Display Name:* ${userInfo.displayname || 'Not set'}
*Status:* ${userInfo.deactivated ? '❌ Deactivated' : '✅ Active'}
*Admin:* ${userInfo.admin ? '👑 Yes' : '❌ No'}
*User Type:* ${userInfo.user_type || 'regular'}
*Creation Time:* ${new Date(userInfo.creation_ts * 1000).toLocaleString()}
*Last Seen:* ${userInfo.last_seen_ts ? new Date(userInfo.last_seen_ts * 1000).toLocaleString() : 'Unknown'}
                `;
                
                await bot.editMessageText(infoMessage, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            userInfo.deactivated ? 
                                [{ text: '❌ User Already Deactivated', callback_data: 'noop' }] :
                                [{ text: '🗑️ Deactivate User', callback_data: `deactivate_${userId}` }],
                            [{ text: '🔙 Back to Search', callback_data: 'back_to_search' }],
                            [{ text: '🏠 Main Menu', callback_data: 'back_to_menu' }]
                        ]
                    }
                });
            } catch (error) {
                await bot.editMessageText(`❌ *Error Getting User Info*\n\nError: ${error.message}`, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]]
                    }
                });
            }

        } else if (data === 'back_to_search') {
            const state = userStates.get(chatId);
            if (state && state.search_results) {
                const resultMessage = `🔍 *Search Results*\n\nFound ${state.search_results.length} users matching: "${state.search_term}"\n\nClick on a user to view details or deactivate:`;
                
                await bot.editMessageText(resultMessage, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    ...createSearchResultKeyboard(state.search_results, state.search_term, state.search_page || 0)
                });
            } else {
                await bot.editMessageText('Choose an action:', {
                    chat_id: chatId,
                    message_id: messageId,
                    ...createMainKeyboard()
                });
            }

        } else if (data === 'get_users') {
            await bot.editMessageText('🔄 Fetching users from Matrix server...', {
                chat_id: chatId,
                message_id: messageId
            });

            const usersData = await matrixClient.getUsers();
            const users = usersData.users || [];
            
            if (users.length === 0) {
                await bot.editMessageText('ℹ️ No users found on the server.', {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: {
                        inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]]
                    }
                });
                return;
            }

            let usersList = `👥 *Users on Matrix Server* (${users.length} total)\n\n`;
            users.forEach((user, index) => {
                const status = user.deactivated ? '❌ Deactivated' : '✅ Active';
                const userType = user.admin ? ' (Admin)' : user.user_type ? ` (${user.user_type})` : '';
                usersList += `${index + 1}. ${user.displayname || user.name}${userType}\n`;
                usersList += `   └ ${user.name} - ${status}\n\n`;
            });

            // Split message if too long
            if (usersList.length > 4096) {
                usersList = usersList.substring(0, 4090) + '...\n\n_List truncated_';
            }

            await bot.editMessageText(usersList, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]]
                }
            });

        } else if (data === 'deactivate_menu') {
            await bot.editMessageText('🔄 Loading users for deactivation...', {
                chat_id: chatId,
                message_id: messageId
            });

            const usersData = await matrixClient.getUsers();
            // Filter out deactivated users AND admin users for safety
            const deactivatableUsers = (usersData.users || []).filter(user => !user.deactivated && !user.admin);
            
            if (deactivatableUsers.length === 0) {
                const totalActive = (usersData.users || []).filter(user => !user.deactivated).length;
                const adminCount = (usersData.users || []).filter(user => !user.deactivated && user.admin).length;
                
                let message = 'ℹ️ No users available for deactivation.';
                if (adminCount > 0) {
                    message += `\n\n👑 Found ${adminCount} admin user(s) that cannot be deactivated for security reasons.`;
                }
                
                await bot.editMessageText(message, {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: {
                        inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]]
                    }
                });
                return;
            }

            userStates.set(chatId, { users: deactivatableUsers, page: 0 });

            await bot.editMessageText('❌ *Select user to deactivate:*\n\n⚠️ Admin users are protected and not shown in this list.', {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                ...createUserSelectionKeyboard(deactivatableUsers, 0)
            });

        } else if (data.startsWith('deactivate_page_')) {
            const page = parseInt(data.split('_')[2]);
            const state = userStates.get(chatId);
            
            if (state && state.users) {
                state.page = page;
                userStates.set(chatId, state);
                
                await bot.editMessageReplyMarkup(
                    createUserSelectionKeyboard(state.users, page).reply_markup,
                    { chat_id: chatId, message_id: messageId }
                );
            }

        } else if (data.startsWith('deactivate_')) {
            const userId = data.substring('deactivate_'.length);
            
            await bot.editMessageText(`⚠️ *Confirm Deactivation*\n\nAre you sure you want to deactivate user:\n\`${userId}\`\n\n⚠️ This action cannot be undone!`, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Yes, Deactivate', callback_data: `confirm_deactivate_${userId}` },
                            { text: '❌ Cancel', callback_data: 'deactivate_menu' }
                        ]
                    ]
                }
            });

        } else if (data.startsWith('confirm_deactivate_')) {
            const userId = data.substring('confirm_deactivate_'.length);
            
            await bot.editMessageText(`🔄 Deactivating user ${userId}...`, {
                chat_id: chatId,
                message_id: messageId
            });

            try {
                await matrixClient.deactivateUser(userId);
                
                // Log the deactivation
                const userInfo = `${user.first_name || ''} ${user.last_name || ''}`.trim();
                const username = user.username ? `@${user.username}` : 'no username';
                console.log(`🔴 User deactivated by authorized admin:`);
                console.log(`   Admin: ${userInfo} (${username})`);
                console.log(`   Admin ID: ${user.id}`);
                console.log(`   Deactivated: ${userId}`);
                console.log(`   Time: ${new Date().toISOString()}`);
                
                await bot.editMessageText(`✅ *User Deactivated Successfully*\n\nUser \`${userId}\` has been deactivated.`, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '❌ Deactivate Another', callback_data: 'deactivate_menu' }],
                            [{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]
                        ]
                    }
                });
            } catch (error) {
                await bot.editMessageText(`❌ *Deactivation Failed*\n\nError: ${error.message}`, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔄 Try Again', callback_data: 'deactivate_menu' }],
                            [{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]
                        ]
                    }
                });
            }

        } else if (data === 'back_to_menu') {
            userStates.delete(chatId);
            await bot.editMessageText('Choose an action:', {
                chat_id: chatId,
                message_id: messageId,
                ...createMainKeyboard()
            });

        } else if (data === 'noop') {
            // Do nothing, just answer the callback
            return;
        }

    } catch (error) {
        console.error('Callback query error:', error);
        await bot.editMessageText(`❌ Error: ${error.message}`, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
                inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]]
            }
        });
    }
}));

// Error handling
bot.on('error', (error) => {
    console.error('Bot error:', error);
});

// Startup message with security info
console.log('🤖 Telegram Matrix Admin Bot (Complete Version) started...');
console.log('🔒 Security Configuration:');
console.log(`   Authorized User IDs: ${AUTHORIZED_USERS.length > 0 ? AUTHORIZED_USERS.join(', ') : 'None'}`);
console.log(`   Authorized Usernames: ${AUTHORIZED_USERNAMES.length > 0 ? AUTHORIZED_USERNAMES.join(', ') : 'None'}`);

if (AUTHORIZED_USERS.length === 0 && AUTHORIZED_USERNAMES.length === 0) {
    console.error('⚠️  WARNING: No authorized users configured! Bot will deny all access.');
    console.error('   Please set AUTHORIZED_USERS or AUTHORIZED_USERNAMES in your .env file');
}

process.on('SIGINT', () => {
    console.log('Bot stopping...');
    bot.stopPolling();
    process.exit(0);
});