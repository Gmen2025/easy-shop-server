const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { sendPushToTokens } = require('../helpers/push-notify');

const validCountries = ['Ethiopia', 'USA'];
const validPriorities = ['Low', 'Normal', 'High', 'Emergency'];
const validStatuses = ['new', 'assigned', 'in_progress', 'quoted', 'completed', 'cancelled'];

const getServiceRequestModel = (req) => req.dbModels?.ServiceRequest;

const normalizeStringList = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
};

const resolveCurrency = (country) => {
  if (String(country || '').trim().toLowerCase() === 'usa') {
    return 'USD';
  }

  return 'ETB';
};

router.get('/mine', async (req, res) => {
  const ServiceRequest = getServiceRequestModel(req);

  if (!ServiceRequest) {
    return res.status(500).json({ success: false, message: 'ServiceRequest model not available' });
  }

  if (!req.auth?.userId) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  const requests = await ServiceRequest.find({ customer: req.auth.userId })
    .populate('customer', 'name email phone')
    .sort({ createdAt: -1 });

  return res.status(200).json(requests);
});

router.get('/assigned', async (req, res) => {
  const ServiceRequest = getServiceRequestModel(req);

  if (!ServiceRequest) {
    return res.status(500).json({ success: false, message: 'ServiceRequest model not available' });
  }

  if (!req.auth?.userId) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  const requests = await ServiceRequest.find({ assignedTechnician: req.auth.userId })
    .populate('customer', 'name email phone')
    .sort({ priority: -1, createdAt: -1 });

  return res.status(200).json(requests);
});

router.get('/', async (req, res) => {
  const ServiceRequest = getServiceRequestModel(req);

  if (!ServiceRequest) {
    return res.status(500).json({ success: false, message: 'ServiceRequest model not available' });
  }

  if (req.auth && !req.auth.isAdmin && req.query.customer && String(req.query.customer) !== String(req.auth.userId)) {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }

  const filter = {};
  if (req.query.customer) {
    filter.customer = req.query.customer;
  }
  if (!req.auth?.isAdmin) {
    filter.customer = req.auth.userId;
  }

  const requests = await ServiceRequest.find(filter)
    .populate('customer', 'name email phone')
    .sort({ createdAt: -1 });

  return res.status(200).json(requests);
});

router.get('/:id', async (req, res) => {
  const ServiceRequest = getServiceRequestModel(req);

  if (!ServiceRequest) {
    return res.status(500).json({ success: false, message: 'ServiceRequest model not available' });
  }

  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid service request ID' });
  }

  const request = await ServiceRequest.findById(req.params.id).populate('customer', 'name email phone');

  if (!request) {
    return res.status(404).json({ success: false, message: 'Service request not found' });
  }

  if (req.auth?.userId && !req.auth.isAdmin && String(request.customer?._id || request.customer) !== String(req.auth.userId)) {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }

  return res.status(200).json(request);
});

router.post('/', async (req, res) => {
  const ServiceRequest = getServiceRequestModel(req);

  if (!ServiceRequest) {
    return res.status(500).json({ success: false, message: 'ServiceRequest model not available' });
  }

  const payload = req.body || {};
  const customerId = payload.customer || req.auth?.userId;

  if (!req.auth?.userId && !payload.customer) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  if (!customerId) {
    return res.status(400).json({ success: false, message: 'customer is required' });
  }

  if (!mongoose.isValidObjectId(String(customerId))) {
    return res.status(400).json({ success: false, message: 'Invalid customer ID' });
  }

  const country = String(payload.country || '').trim();
  const serviceLocation = String(payload.serviceLocation || '').trim();
  const machineType = String(payload.machineType || '').trim();
  const problemDescription = String(payload.problemDescription || '').trim();

  if (!validCountries.includes(country)) {
    return res.status(400).json({ success: false, message: 'country must be one of: Ethiopia, USA' });
  }

  if (!serviceLocation) {
    return res.status(400).json({ success: false, message: 'serviceLocation is required' });
  }

  if (!machineType) {
    return res.status(400).json({ success: false, message: 'machineType is required' });
  }

  if (!problemDescription) {
    return res.status(400).json({ success: false, message: 'problemDescription is required' });
  }

  const priority = validPriorities.includes(String(payload.priority || 'Normal'))
    ? String(payload.priority)
    : 'Normal';

  const created = await ServiceRequest.create({
    customer: customerId,
    country,
    serviceLocation,
    machineType,
    manufacturer: String(payload.manufacturer || '').trim(),
    model: String(payload.model || '').trim(),
    controller: String(payload.controller || '').trim(),
    errorCode: String(payload.errorCode || '').trim(),
    problemDescription,
    priority,
    locationCity: String(payload.locationCity || '').trim(),
    locationAddress: String(payload.locationAddress || '').trim(),
    photos: normalizeStringList(payload.photos),
    videos: normalizeStringList(payload.videos),
    status: validStatuses.includes(String(payload.status || 'new')) ? String(payload.status) : 'new',
    currency: String(payload.currency || resolveCurrency(country)).trim(),
    budgetEstimate: payload.budgetEstimate !== undefined && payload.budgetEstimate !== null
      ? Number(payload.budgetEstimate)
      : null,
    createdByAdmin: Boolean(payload.createdByAdmin),
  });

  return res.status(201).json(created);
});

router.put('/:id', async (req, res) => {
  const ServiceRequest = getServiceRequestModel(req);

  if (!ServiceRequest) {
    return res.status(500).json({ success: false, message: 'ServiceRequest model not available' });
  }

  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid service request ID' });
  }

  const payload = req.body || {};
  const existing = await ServiceRequest.findById(req.params.id);

  if (!existing) {
    return res.status(404).json({ success: false, message: 'Service request not found' });
  }

  const isAdmin = Boolean(req.auth?.isAdmin);
  const isOwner = String(existing.customer) === String(req.auth?.userId);
  const isTechnician = String(existing.assignedTechnician || '') === String(req.auth?.userId || '');
  if (!isAdmin && !isOwner && !isTechnician) {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }

  const adminOnlyFields = ['quotedPrice', 'currency', 'budgetEstimate', 'assignedTechnician'];
  if (!isAdmin && (adminOnlyFields.some((field) => payload[field] !== undefined)
    || (payload.status !== undefined && !isTechnician)
    || (payload.technicianNotes !== undefined && !isTechnician))) {
    return res.status(403).json({ success: false, message: 'Only an administrator can update service management fields' });
  }

  if (payload.quoteAccepted !== undefined && !isOwner) {
    return res.status(403).json({ success: false, message: 'Only the customer can accept a quote' });
  }

  const nextCountry = payload.country || existing.country;
  const nextStatus = validStatuses.includes(String(payload.status || existing.status))
    ? String(payload.status || existing.status)
    : existing.status;
  const nextPriority = validPriorities.includes(String(payload.priority || existing.priority))
    ? String(payload.priority || existing.priority)
    : existing.priority;

  if (payload.country && !validCountries.includes(String(payload.country))) {
    return res.status(400).json({ success: false, message: 'country must be one of: Ethiopia, USA' });
  }

  const updated = await ServiceRequest.findByIdAndUpdate(
    req.params.id,
    {
      ...(payload.country ? { country: String(payload.country).trim() } : {}),
      ...(payload.serviceLocation !== undefined ? { serviceLocation: String(payload.serviceLocation).trim() } : {}),
      ...(payload.machineType !== undefined ? { machineType: String(payload.machineType).trim() } : {}),
      ...(payload.manufacturer !== undefined ? { manufacturer: String(payload.manufacturer).trim() } : {}),
      ...(payload.model !== undefined ? { model: String(payload.model).trim() } : {}),
      ...(payload.controller !== undefined ? { controller: String(payload.controller).trim() } : {}),
      ...(payload.errorCode !== undefined ? { errorCode: String(payload.errorCode).trim() } : {}),
      ...(payload.problemDescription !== undefined ? { problemDescription: String(payload.problemDescription).trim() } : {}),
      ...(payload.priority !== undefined ? { priority: nextPriority } : {}),
      ...(payload.locationCity !== undefined ? { locationCity: String(payload.locationCity).trim() } : {}),
      ...(payload.locationAddress !== undefined ? { locationAddress: String(payload.locationAddress).trim() } : {}),
      ...(payload.photos !== undefined ? { photos: normalizeStringList(payload.photos) } : {}),
      ...(payload.videos !== undefined ? { videos: normalizeStringList(payload.videos) } : {}),
      ...(payload.status !== undefined ? { status: nextStatus } : {}),
      ...(payload.quotedPrice !== undefined ? { quotedPrice: Number(payload.quotedPrice) } : {}),
      ...(payload.quoteAccepted !== undefined ? { quoteAccepted: Boolean(payload.quoteAccepted) } : {}),
      ...(payload.assignedTechnician !== undefined ? { assignedTechnician: payload.assignedTechnician || null } : {}),
      ...(payload.technicianNotes !== undefined ? { technicianNotes: String(payload.technicianNotes).trim() } : {}),
      ...(payload.currency !== undefined ? { currency: String(payload.currency).trim() } : {}),
      ...(payload.budgetEstimate !== undefined ? { budgetEstimate: Number(payload.budgetEstimate) } : {}),
    },
    { new: true }
  );

  if (payload.assignedTechnician !== undefined && updated.assignedTechnician) {
    const Driver = req.dbModels?.Driver;
    const driver = Driver ? await Driver.findById(updated.assignedTechnician).select('name pushTokens') : null;
    const assignmentPayload = {
      type: 'service_request_assigned',
      request: updated,
      serviceRequestId: String(updated._id),
      driverId: String(updated.assignedTechnician),
    };
    const io = req.app.get('io');
    io?.to(`driver:${updated.assignedTechnician}`).emit('service_request_assigned', assignmentPayload);
    await sendPushToTokens({
      tokens: driver?.pushTokens || [],
      title: 'New service job assigned',
      body: `${updated.machineType || 'Machine service'} needs your attention.`,
      data: assignmentPayload,
    });
  }

  if (payload.currency === undefined && !updated.currency) {
    updated.currency = resolveCurrency(nextCountry);
    await updated.save();
  }

  return res.status(200).json(updated);
});

router.delete('/:id', async (req, res) => {
  const ServiceRequest = getServiceRequestModel(req);

  if (!ServiceRequest) {
    return res.status(500).json({ success: false, message: 'ServiceRequest model not available' });
  }

  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid service request ID' });
  }

  const deleted = await ServiceRequest.findByIdAndDelete(req.params.id);

  if (!deleted) {
    return res.status(404).json({ success: false, message: 'Service request not found' });
  }

  return res.status(200).json({ success: true, deletedId: deleted._id });
});

module.exports = router;
