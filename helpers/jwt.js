const {expressjwt : jwt} = require('express-jwt');


function authJwt() {
    const secret = process.env.secret;
    return jwt({
        secret,
        algorithms: ['HS256']
    }).unless({
        path : [
            '/api/v1/users/login',
            '/api/v1/users/register',
            {url : /\/public\/uploads(.*)/, methods : ['GET', 'OPTIONS']},
            {url : /\/api\/v1\/products(.*)/, methods : ['GET', 'OPTIONS']},
            {url : /\/api\/v1\/categories(.*)/, methods : ['GET', 'OPTIONS']}
        ]
    })
}

module.exports = authJwt;