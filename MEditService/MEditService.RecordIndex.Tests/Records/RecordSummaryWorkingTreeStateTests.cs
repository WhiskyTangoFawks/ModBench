using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class RecordSummaryWorkingTreeStateTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _base;
    private readonly PluginAddress _baseKey;
    private readonly FormKey _editedFormKey;

    public RecordSummaryWorkingTreeStateTests()
    {
        FormKey edited = default;
        _fixture = new PluginFixtureBuilder("record-summary-working-tree-state")
            .WithPlugin("Base.esm", mod => edited = mod.Npcs.AddNew("EditedOriginal").FormKey, origin: "BaseMod")
            .BuildScattered()
            .CompiledPlugin();
        _base = _fixture.Plugins.Single();
        _baseKey = _base.Key;
        _editedFormKey = edited;
    }

    public void Dispose() => _fixture.Dispose();

    private static RecordSummary SummaryFor(PagedResult<RecordSummary> page, string formKey) =>
        page.Items.Single(i => i.FormKey == formKey);

    private PagedResult<RecordSummary> Listing(OpenedIndex index) =>
        index.Queries.GetRecords(["npc_"], _baseKey, search: null, limit: 50, offset: 0).Value();

    [Fact]
    public void AnEditCommittedOutsideModbench_IsListedUnchanged_OnTheNextArrival()
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
    public void WhileAChangedFileIsHeld_TheBinarysRecordsAreListedUnchanged_AndOnceReleased_ModifiedAgain()
    {
        using var index = Indexes.Reconciled(_fixture);
        var edited = _editedFormKey.ToString();
        var committed = index.DocumentOf(edited, _baseKey);
        index.Edit(_base, committed, index.BodyOf(edited, _baseKey).Replace("EditedOriginal", "EditedNew", StringComparison.Ordinal));
        using (new FileStream(_base.SourceFileOf(committed), FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            index.NextSnapshotUntil(
                () => index.ReadFromItsPluginFileForItsUnreadableSource(_baseKey), "the binary read in the tree's place");

            Assert.Equal(WorkingTreeState.None, SummaryFor(Listing(index), edited).WorkingTreeState);
        }

        index.NextSnapshotUntil(() => index.ReadFromItsPluginSource(_baseKey), "the tree read again");

        Assert.Equal(WorkingTreeState.Modified, SummaryFor(Listing(index), edited).WorkingTreeState);
    }
}
