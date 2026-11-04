function financeHooks(schema, sourceType) {
  const { randomUUID } = require("crypto");
  schema.add({ financeSyncKey: { type: String } });
  schema.index({ financeSyncKey: 1 }, { sparse: true });
  schema.pre("save", function () {
    this.financeSyncKey = randomUUID();
  });
  const sync = async (Model, source, session) => {
    if (!source || !Model.db.models.FinanceEntry) return;
    const { completed } = require("./finance");
    if (!completed(sourceType, source) &&
        !await Model.db.models.FinanceEntry.exists({ sourceType, sourceId: source._id }).session(session || null)) {
      await require("./finance").clearSyncKey(Model.db.models, sourceType, source, session || null);
      return;
    }
    await require("./finance").syncSource(Model.db.models, sourceType, source, session || null);
  };
  schema.post("save", async function (document) {
    await sync(this.constructor, document.toObject(), document.$session());
  });
  for (const operation of ["findOneAndUpdate", "updateOne"]) {
    schema.pre(operation, async function () {
      this._financeSourceId = (await this.model.findOne(this.getFilter()).select("_id")
        .session(this.getOptions().session || null).lean())?._id;
      this.set({ financeSyncKey: randomUUID() });
    });
    schema.post(operation, async function () {
      if (!this._financeSourceId) return;
      const source = await this.model.findById(this._financeSourceId).session(this.getOptions().session || null).lean();
      await sync(this.model, source, this.getOptions().session);
    });
  }
  schema.pre("deleteOne", { document: true, query: false }, async function () {
    await sync(this.constructor, this.toObject(), this.$session());
  });
  for (const operation of ["findOneAndDelete", "deleteOne"]) {
    schema.pre(operation, { query: true, document: false }, async function () {
      const source = await this.model.findOne(this.getFilter()).session(this.getOptions().session || null).lean();
      await sync(this.model, source, this.getOptions().session);
    });
  }
}

module.exports = financeHooks;
