using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

public sealed class RecordSummaryWorkingTreeStateTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _base;
    private readonly PluginAddress _baseKey;
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

    private PagedResult<RecordSummary> Listing(OpenedIndex index) =>
        index.Queries.GetRecords(["npc_"], _baseKey, search: null, limit: 50, offset: 0).Value();

    [Fact]
    public void Search_EditedRecord_ReportsModified_AndUntouchedSiblingReportsNone()
    {
        using var index = Indexes.Reconciled(_fixture);
        var edited = _editedFormKey.ToString();
        var committed = index.DocumentOf(edited, _baseKey);
        index.Edit(_base, committed, index.BodyOf(edited, _baseKey).Replace("EditedOriginal", "EditedNew", StringComparison.Ordinal));

        var page = Listing(index);

        Assert.Equal(WorkingTreeState.Modified, SummaryFor(page, edited).WorkingTreeState);
        Assert.Equal(WorkingTreeState.None, SummaryFor(page, _untouchedFormKey.ToString()).WorkingTreeState);
    }

    [Fact]
    public void Search_NewlyCreatedRecord_ReportsAdded()
    {
        using var index = Indexes.Reconciled(_fixture);
        var template = index.DocumentOf(_untouchedFormKey.ToString(), _baseKey);
        var created = new FormKey(_untouchedFormKey.ModKey, _untouchedFormKey.ID + 1).ToString();
        var body = index.BodyOf(_untouchedFormKey.ToString(), _baseKey)
            .Replace(_untouchedFormKey.ToString(), created, StringComparison.Ordinal)
            .Replace("Untouched", "CreatedInTree", StringComparison.Ordinal);
        index.Create(_base, created, "npc_", "CreatedInTree", body);

        var page = Listing(index);

        Assert.Equal(WorkingTreeState.Added, SummaryFor(page, created).WorkingTreeState);
        Assert.Equal(WorkingTreeState.None, SummaryFor(page, _untouchedFormKey.ToString()).WorkingTreeState);
    }

    [Fact]
    public void Search_AfterACommitMadeOutsideModbench_ReportsNone_OnTheNextArrival()
    {
        using var index = Indexes.Reconciled(_fixture);
        var edited = _editedFormKey.ToString();
        var committed = index.DocumentOf(edited, _baseKey);
        index.Edit(_base, committed, index.BodyOf(edited, _baseKey).Replace("EditedOriginal", "EditedNew", StringComparison.Ordinal));
        Assert.Equal(WorkingTreeState.Modified, SummaryFor(Listing(index), edited).WorkingTreeState);

        _base.Git("add", "-A");
        _base.Git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "outside");
        index.NextSnapshot();

        Assert.Equal(WorkingTreeState.None, SummaryFor(Listing(index), edited).WorkingTreeState);
    }

    [Fact]
    public void Search_WhileAChangedFileIsHeld_ListsTheBinarysRecords_AndOnceReleased_ReportsModifiedAgain()
    {
        using var index = Indexes.Reconciled(_fixture);
        var edited = _editedFormKey.ToString();
        var committed = index.DocumentOf(edited, _baseKey);
        index.Edit(_base, committed, index.BodyOf(edited, _baseKey).Replace("EditedOriginal", "EditedNew", StringComparison.Ordinal));
        using (new FileStream(_base.SourceFileOf(committed), FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            index.NextSnapshotUntil(
                () => index.PluginRowOf(_baseKey) is { IsTracked: true, PluginSourceUnreadable: not null }, "the binary read in the tree's place");

            Assert.Equal(WorkingTreeState.None, SummaryFor(Listing(index), edited).WorkingTreeState);
        }

        index.NextSnapshotUntil(() => index.PluginRowOf(_baseKey) is { IsTracked: true, PluginSourceUnreadable: null }, "the tree read again");

        Assert.Equal(WorkingTreeState.Modified, SummaryFor(Listing(index), edited).WorkingTreeState);
    }
}
