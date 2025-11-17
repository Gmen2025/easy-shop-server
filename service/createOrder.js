const applyFabricToken = require("./applyFabricToken");
const tools = require("../utils/tools");
const config = require("../config/config");
const axios = require('axios');


exports.createOrder = async (req, res) => {
  try {
    const { title, amount } = req.body;
    
    // Validate inputs
    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return res.status(400).json({ error: 'Valid title is required' });
    }
    
    if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Valid amount is required' });
    }

    console.log('Creating order for:', { title, amount });
    
    let applyFabricTokenResult = await applyFabricToken.applyFabricToken();
    if (!applyFabricTokenResult || !applyFabricTokenResult.token) {
      throw new Error('Failed to get fabric token');
    }
    
    let fabricToken = applyFabricTokenResult.token;
    
    let createOrderResult = await exports.requestCreateOrder(
      fabricToken,
      title,
      amount
    );
    
    if (!createOrderResult || !createOrderResult.biz_content || !createOrderResult.biz_content.prepay_id) {
      throw new Error('Invalid response from payment service');
    }
    
    let prepayId = createOrderResult.biz_content.prepay_id;
    let rawRequest = createRawRequest(prepayId);

    const finalUrl = config.webBaseUrl + rawRequest + "&version=1.0&trade_type=Checkout";
    
    res.json({
      success: true,
      payment_url: finalUrl,
      prepay_id: prepayId
    });
    
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to create order' 
    });
  }
};

exports.requestCreateOrder = async (fabricToken, title, amount) => {
 try {
    let reqObject = createRequestObject(title, amount);
    
    const response = await axios.post(
      config.baseUrl + "/payment/v1/merchant/preOrder",
      reqObject,
      {
        headers: {
          "Content-Type": "application/json",
          "X-APP-Key": config.fabricAppId,
          Authorization: fabricToken,
        },
        timeout: 30000
      }
    );

    console.log('API Response:', response.data);
    return response.data;
  } catch (error) {
    throw new Error(`Request failed: ${error.message}`);
  }
};

function createRequestObject(title, amount) {
  let req = {
    timestamp: tools.createTimeStamp(),
    nonce_str: tools.createNonceStr(),
    method: "payment.preorder",
    version: "1.0",
  };
  let biz = {
    notify_url: config.notifyUrl || "https://yourdomain.com/api/v1/telebirr/webhook", // ❌ This should be your actual webhook URL
    appid: config.merchantAppId,
    merch_code: config.merchantCode,
    merch_order_id: createMerchantOrderId(),
    trade_type: "Checkout",
    title: title,
    total_amount: amount,
    trans_currency: "ETB",
    timeout_express: "120m",
    business_type: "BuyGoods",
    payee_identifier: config.merchantCode,
    payee_identifier_type: "04",
    payee_type: "5000",
    //redirect_url: "easyshopping://payment-success", // Deep link to your app
    //redirect_url: "https://www.bing.com/", // ❌ This should redirect back to your app
    //redirect_url: config.redirectUrl || "https://yourdomain.com/payment/success",
    callback_info: `Mobile payment for ${title}`,
  };
  req.biz_content = biz;
  req.sign = tools.signRequestObject(req); // generate signature
  req.sign_type = "SHA256WithRSA";
  //console.log(req);
  return req;
}

function createMerchantOrderId() {
  return new Date().getTime() + "";
}

function createRawRequest(prepayId) {
  let map = {
    appid: config.merchantAppId,
    merch_code: config.merchantCode,
    nonce_str: tools.createNonceStr(),
    prepay_id: prepayId,
    timestamp: tools.createTimeStamp(),
  };
  let sign = tools.signRequestObject(map); // generate signature
  // order by ascii in array. Key=Value joined by & 
  //appid=MyApp123&merch_code=MERCHANT001&nonce_str=abc123xyz&
  // prepay_id=PREPAY456&timestamp=1634567890&sign=ABC123DEF456&
  // sign_type=SHA256WithRSA
  //Alternative syntax: `appid=${map.appid}`,
  let rawRequest = [
    "appid=" + map.appid, // "appid=MyApp123"
    "merch_code=" + map.merch_code, // "merch_code=MERCHANT001"
    "nonce_str=" + map.nonce_str, // "nonce_str=abc123xyz"
    "prepay_id=" + map.prepay_id, // "prepay_id=PREPAY456"
    "timestamp=" + map.timestamp, // "timestamp=1634567890"
    "sign=" + sign, // "sign=ABC123DEF456"
    "sign_type=SHA256WithRSA", // "sign_type=SHA256WithRSA"
  ].join("&");
  return rawRequest;
}
