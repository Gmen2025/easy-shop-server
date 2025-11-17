

exports.mockApplyFabricToken = async () => {
  return {
    token: "MOCK_FABRIC_TOKEN_" + Date.now(),
    expires_in: 3600
  };
};

exports.mockCreateOrder = async (fabricToken, title, amount) => {
  return {
    biz_content: {
      prepay_id: "MOCK_PREPAY_ID_" + Date.now(),
      order_id: "MOCK_ORDER_" + Date.now()
    },
    success: true
  };
};