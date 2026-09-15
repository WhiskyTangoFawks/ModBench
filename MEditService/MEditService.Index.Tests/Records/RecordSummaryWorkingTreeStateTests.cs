using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Records;

/// <summary>Pinned at the listing seam: <c>Search</c>, not <c>GetOverrideStack</c>, is what the
/// Plugins tree calls, and it is the only real producer of a non-None value.</summary>
public sealed class RecordSummaryWorkingTreeStateTests : IDisposable
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);
    private static readonly PluginKey BaseKey = new("Base.esm", "Data");

    private readonly PluginFixtureData _fixture;
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
            })
            .Build();
        _editedFormKey = edited;
        _untouchedFormKey = untouched;
    }

    public void Dispose() => _fixture.Dispose();

    private DuckDbRecordIndex LoadedIndex()
    {
        var index = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        index.Initialize(GameRelease.Fallout4);
        var path = new ModPath(ModKey.FromFileName("Base.esm"), Path.Combine(_fixture.DataFolder, "Base.esm"));
        index.IndexMod(Fallout4Mod.CreateFromBinaryOverlay(path, Fallout4Release.Fallout4), Registration.Participating(0), BaseKey);
        index.UpdateWinners();
        return index;
    }

    private static RecordSummary SummaryFor(PagedResult<RecordSummary> page, string formKey) =>
        page.Items.Single(i => i.FormKey == formKey);

    [Fact]
    public void Search_EditedRecord_ReportsModified_AndUntouchedSiblingReportsNone()
    {
        using var index = LoadedIndex();
        var edited = _editedFormKey.ToString();
        var committed = index.At(RecordRef.Effective).GetDocument(edited, BaseKey)!;
        index.ProjectDocuments(
            BaseKey, [(edited, committed.Body!.Replace("EditedOriginal", "EditedNew", StringComparison.Ordinal))]);

        var page = index.At(RecordRef.Effective).Search(new RecordQuery(Plugin: BaseKey, RecordTypes: ["npc_"], Limit: 50));

        Assert.Equal(WorkingTreeState.Modified, SummaryFor(page, edited).WorkingTreeState);
        Assert.Equal(WorkingTreeState.None, SummaryFor(page, _untouchedFormKey.ToString()).WorkingTreeState);
    }

    [Fact]
    public void Search_NewlyCreatedRecord_ReportsAdded()
    {
        using var index = LoadedIndex();
        // A created record is one no committed ref holds — the state ingest reconciles a new source
        // document into, and the only thing the listing can read.
        var created = _untouchedFormKey.ToString();
        index.MarkWorkingTreeOnly(BaseKey, [created]);

        var page = index.At(RecordRef.Effective).Search(new RecordQuery(Plugin: BaseKey, RecordTypes: ["npc_"], Limit: 50));

        Assert.Equal(WorkingTreeState.Added, SummaryFor(page, created).WorkingTreeState);
    }

    // A ref-scoped Search forwarding the same reader logic without HeadRelation's "Ref" column being
    // uniformly 'committed' would leak Effective's Modified/Added values into the Head answer, which
    // never has dirt.
    [Fact]
    public void Search_AtHead_AlwaysReportsNone_EvenForARecordDirtyAtEffective()
    {
        using var index = LoadedIndex();
        var edited = _editedFormKey.ToString();
        var committed = index.At(RecordRef.Effective).GetDocument(edited, BaseKey)!;
        index.ProjectDocuments(
            BaseKey, [(edited, committed.Body!.Replace("EditedOriginal", "EditedNew", StringComparison.Ordinal))]);

        var headPage = index.At(RecordRef.Head).Search(new RecordQuery(Plugin: BaseKey, RecordTypes: ["npc_"], Limit: 50));

        Assert.All(headPage.Items, i => Assert.Equal(WorkingTreeState.None, i.WorkingTreeState));
    }
}
