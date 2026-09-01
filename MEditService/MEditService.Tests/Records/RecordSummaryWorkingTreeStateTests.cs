using System.Text;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Records;

/// <summary>
/// <see cref="RecordSummary.WorkingTreeState"/> is the Plugins-tree listing's own
/// working-tree fact — <see cref="IRecordReads.Search"/> is the only real producer of a non-None
/// value (every other construction site defaults it). None/Modified/Added read off the same
/// <c>"ref"</c> plus <c>records_committed</c>-presence facts <see cref="WorkingTreeChangeTests"/> and
/// <see cref="WorkingTreeCreationTests"/> already pin at the document/override-stack seam; this file
/// pins them at the listing seam instead, since <c>Search</c> — not <c>GetOverrideStack</c> — is what
/// the Plugins tree actually calls (<c>PluginTreeProvider.fetchRecords</c> → <c>GET /records</c>).
/// </summary>
public sealed class RecordSummaryWorkingTreeStateTests : IDisposable
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);
    private static readonly PluginKey BaseKey = new("Base.esm", "Data");
    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);

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
        index.Index(Fallout4Mod.CreateFromBinaryOverlay(path, Fallout4Release.Fallout4), Registration.Participating(0), BaseKey);
        index.UpdateWinners();
        return index;
    }

    // Real codec bytes, the same shape CreateRecord writes in production — mirrors
    // WorkingTreeCreationTests.NewNpcBody rather than a hand-crafted JSON literal.
    private static string NewNpcBody(string formKey, string editorId)
    {
        var npc = new Npc(FormKey.Factory(formKey), Fallout4Release.Fallout4) { EditorID = editorId };
        var bytes = Codec.SerializeToBytesAsync(npc, GameRelease.Fallout4).GetAwaiter().GetResult();
        return Encoding.UTF8.GetString(bytes);
    }

    private static RecordSummary SummaryFor(PagedResult<RecordSummary> page, string formKey) =>
        page.Items.Single(i => i.FormKey == formKey);

    [Fact]
    public void Search_EditedRecord_ReportsModified_AndUntouchedSiblingReportsNone()
    {
        using var index = LoadedIndex();
        var edited = _editedFormKey.ToString();
        var committed = index.At(RecordRef.Effective).GetDocument(edited, BaseKey)!;
        index.ApplyWorkingTreeChanges(
            BaseKey, [(edited, committed.Body!.Replace("EditedOriginal", "EditedNew", StringComparison.Ordinal))]);

        var page = index.At(RecordRef.Effective).Search(new RecordQuery(Plugin: BaseKey, RecordTypes: ["npc_"], Limit: 50));

        Assert.Equal(WorkingTreeState.Modified, SummaryFor(page, edited).WorkingTreeState);
        Assert.Equal(WorkingTreeState.None, SummaryFor(page, _untouchedFormKey.ToString()).WorkingTreeState);
    }

    [Fact]
    public void Search_NewlyCreatedRecord_ReportsAdded()
    {
        using var index = LoadedIndex();
        var created = "800000:Base.esm";
        index.CreateWorkingTreeRecord(BaseKey, created, "npc_", NewNpcBody(created, "BrandNew"));

        var page = index.At(RecordRef.Effective).Search(new RecordQuery(Plugin: BaseKey, RecordTypes: ["npc_"], Limit: 50));

        Assert.Equal(WorkingTreeState.Added, SummaryFor(page, created).WorkingTreeState);
    }

    // A ref-scoped Search that forwards the same SQL/reader logic without HeadRelation's
    // own "ref" column being uniformly 'committed' would leak Effective's Modified/Added values into
    // the Head answer — Head never has dirt (Search() is Effective-only,
    // but the Head-scoped surface still exists and must not lie about it).
    [Fact]
    public void Search_AtHead_AlwaysReportsNone_EvenForARecordDirtyAtEffective()
    {
        using var index = LoadedIndex();
        var edited = _editedFormKey.ToString();
        var committed = index.At(RecordRef.Effective).GetDocument(edited, BaseKey)!;
        index.ApplyWorkingTreeChanges(
            BaseKey, [(edited, committed.Body!.Replace("EditedOriginal", "EditedNew", StringComparison.Ordinal))]);

        var headPage = index.At(RecordRef.Head).Search(new RecordQuery(Plugin: BaseKey, RecordTypes: ["npc_"], Limit: 50));

        Assert.All(headPage.Items, i => Assert.Equal(WorkingTreeState.None, i.WorkingTreeState));
    }
}
