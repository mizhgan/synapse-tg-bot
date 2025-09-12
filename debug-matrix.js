require('dotenv').config();
const axios = require('axios');

const MATRIX_URL = process.env.MATRIX_URL;
const MATRIX_ADMIN_TOKEN = process.env.MATRIX_ADMIN_TOKEN;

console.log('🔍 Debugging Matrix Connection...');
console.log(`Matrix URL: ${MATRIX_URL}`);
console.log(`Admin Token: ${MATRIX_ADMIN_TOKEN ? 'Set (length: ' + MATRIX_ADMIN_TOKEN.length + ')' : 'Not set'}`);
console.log('');

async function testConnection() {
    if (!MATRIX_URL) {
        console.error('❌ MATRIX_URL is not set in .env file');
        return;
    }

    if (!MATRIX_ADMIN_TOKEN) {
        console.error('❌ MATRIX_ADMIN_TOKEN is not set in .env file');
        return;
    }

    // Test 1: Basic URL connectivity
    console.log('🔗 Test 1: Testing basic URL connectivity...');
    try {
        const basicUrl = new URL(MATRIX_URL);
        console.log(`   Protocol: ${basicUrl.protocol}`);
        console.log(`   Hostname: ${basicUrl.hostname}`);
        console.log(`   Port: ${basicUrl.port || (basicUrl.protocol === 'https:' ? '443' : '80')}`);
        
        const response = await axios.get(`${MATRIX_URL}/_matrix/client/versions`, {
            timeout: 10000,
            validateStatus: () => true // Accept any status code
        });
        
        console.log(`   ✅ Server responded with status: ${response.status}`);
        if (response.data) {
            console.log(`   📋 Server data:`, JSON.stringify(response.data, null, 2));
        }
    } catch (error) {
        console.error(`   ❌ Connection failed:`, error.message);
        console.error(`   🔍 Error details:`, error.code || 'Unknown error code');
        
        if (error.code === 'ENOTFOUND') {
            console.error('   💡 Suggestion: Check if the Matrix server URL is correct and the server is running');
        } else if (error.code === 'ECONNREFUSED') {
            console.error('   💡 Suggestion: The server is refusing connections. Check if the port is correct');
        } else if (error.code === 'ETIMEDOUT') {
            console.error('   💡 Suggestion: Connection timeout. Check network connectivity or firewall');
        }
        return;
    }

    // Test 2: Admin API connectivity
    console.log('');
    console.log('🔑 Test 2: Testing admin API access...');
    try {
        const headers = {
            'Authorization': `Bearer ${MATRIX_ADMIN_TOKEN}`,
            'Content-Type': 'application/json'
        };

        const response = await axios.get(`${MATRIX_URL}/_synapse/admin/v1/server_version`, {
            headers,
            timeout: 10000,
            validateStatus: () => true
        });

        console.log(`   ✅ Admin API responded with status: ${response.status}`);
        
        if (response.status === 200) {
            console.log('   🎉 Admin API access successful!');
            console.log(`   📋 Server version:`, JSON.stringify(response.data, null, 2));
        } else if (response.status === 401) {
            console.error('   ❌ Authentication failed - invalid admin token');
        } else if (response.status === 403) {
            console.error('   ❌ Access denied - token may not have admin privileges');
        } else if (response.status === 404) {
            console.error('   ❌ Admin API endpoint not found - check Matrix server configuration');
        } else {
            console.error(`   ❌ Unexpected response: ${response.status}`);
            console.error(`   📋 Response:`, response.data);
        }

    } catch (error) {
        console.error(`   ❌ Admin API test failed:`, error.message);
        return;
    }

    // Test 3: Users endpoint
    console.log('');
    console.log('👥 Test 3: Testing users endpoint...');
    try {
        const headers = {
            'Authorization': `Bearer ${MATRIX_ADMIN_TOKEN}`,
            'Content-Type': 'application/json'
        };

        const response = await axios.get(`${MATRIX_URL}/_synapse/admin/v2/users`, {
            headers,
            params: { from: 0, limit: 5 },
            timeout: 10000,
            validateStatus: () => true
        });

        console.log(`   ✅ Users endpoint responded with status: ${response.status}`);
        
        if (response.status === 200) {
            console.log('   🎉 Users endpoint working!');
            const users = response.data.users || [];
            console.log(`   📊 Found ${users.length} users (showing first 5)`);
            users.forEach((user, index) => {
                console.log(`     ${index + 1}. ${user.name} (${user.user_type || 'regular'})`);
            });
        } else {
            console.error(`   ❌ Users endpoint failed with status: ${response.status}`);
            console.error(`   📋 Response:`, response.data);
        }

    } catch (error) {
        console.error(`   ❌ Users endpoint test failed:`, error.message);
    }
}

// Run tests
testConnection().then(() => {
    console.log('');
    console.log('🏁 Debug completed!');
}).catch(error => {
    console.error('🚨 Debug script failed:', error.message);
});