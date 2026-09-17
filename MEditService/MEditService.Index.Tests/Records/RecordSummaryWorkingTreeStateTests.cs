using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Records;

/// <summary>Pinned at the listing seam: <c>Search</c>, not <c>GetOverrideStack</c>, is what the
/// Plugins tree calls, and it is the only real producer of a non-None value.</summary>
public sealed class RecordSummaryWorkingTreeStateTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _base;
    private readonly PluginCopyKey _baseKey;
    private readonly FormKey _editedFormKey;
    private readonly FormKey _untouchedFormKey;

    public RecordSummaryWorkingTreeStateTests()
    {
        FormKey edited = default, untouched = default;
        _fixture = new PluginFixtureBuilder("record-summary-working-tree-state")
            .WithPlugin("Base.esm", mod =>
            {
                edited = mod.Npcs.AddNew("EditedOriginal").FormKey;
                untouched = mod.Npcs.AddNew("Untouched").FormKey;
            }, origin: "BaseMod")
            .BuildScattered()
            .Tracked();
        _base = _fixture.Plugins.Single();
        _baseKey = _base.KeyOf();
        _editedFormKey = edited;
        _untouchedFormKey = untouched;
    }

    public void Dispose() => _fixture.Dispose();

    private static RecordSummary SummaryFor(PagedResult<RecordSummary> page, string formKey) =>
        page.Items.Single(i => i.FormKey == formKey);

    private PagedResult<RecordSummary> Listing(IndexProjector index) =>
        index.RequireReads().Search(new RecordQuery(Plugin: _baseKey.Name, Origin: _baseKey.Origin, RecordTypes: ["npc_"], Limit: 50));

    [Fact]
    public void Search_EditedRecord_ReportsModified_AndUntouchedSiblingReportsNone()
    {
        using var index = Indexes.Reconciled(_fixture);
        var edited = _editedFormKey.ToString();
        var committed = index.RequireReads().DocumentOf(edited, _baseKey);
        index.Edit(_base, committed, committed.BodyOf().Replace("EditedOriginal", "EditedNew", StringComparison.Ordinal));

        var page = Listing(index);

        Assert.Equal(WorkingTreeState.Modified, SummaryFor(page, edited).WorkingTreeState);
        Assert.Equal(WorkingTreeState.None, SummaryFor(page, _untouchedFormKey.ToString()).WorkingTreeState);
    }

    [Fact]
    public void Search_NewlyCreatedRecord_ReportsAdded()
    {
        using var index = Indexes.Reconciled(_fixture);
        // A created record is one no committed ref holds: a document the working tree gains and the
        // tree is re-read for.
        var template = index.RequireReads().DocumentOf(_untouchedFormKey.ToString(), _baseKey);
        var created = new FormKey(_untouchedFormKey.ModKey, _untouchedFormKey.ID + 1).ToString();
        var body = template.BodyOf()
            .Replace(_untouchedFormKey.ToString(), created, StringComparison.Ordinal)
            .Replace("Untouched", "CreatedInTree", StringComparison.Ordinal);
        index.Create(_base, created, "npc_", "CreatedInTree", body);

        var page = Listing(index);

        Assert.Equal(WorkingTreeState.Added, SummaryFor(page, created).WorkingTreeState);
        Assert.Equal(WorkingTreeState.None, SummaryFor(page, _untouchedFormKey.ToString()).WorkingTreeState);
    }
}
