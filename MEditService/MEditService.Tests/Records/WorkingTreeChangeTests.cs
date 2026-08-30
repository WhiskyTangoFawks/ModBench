using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Records;

/// <summary>
/// #415 AC1/AC2 at the index seam: <see cref="IRecordIndex.ApplyWorkingTreeChanges"/> is what makes
/// <see cref="RecordRef.Effective"/> and <see cref="RecordRef.Head"/> stop being the same answer.
/// #421 shipped them identical by construction (<c>At</c> returned <c>this</c>) and pinned that with
/// <c>RecordRefIdentityTests</c>, which this ticket turns into the divergence tests next door.
///
/// Bodies here are real codec documents — read back out of the index after a real ingest, then
/// edited as text — not hand-written JSON: the invariant under test is "Body bytes = the source
/// file's bytes at that ref", so a fabricated body would test a shape the codec never emits.
/// </summary>
public sealed class WorkingTreeChangeTests : IDisposable
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private readonly PluginFixtureData _fixture;
    private readonly FormKey _npcFormKey;
    private static readonly PluginKey BaseKey = new("Base.esm", "Data");

    public WorkingTreeChangeTests()
    {
        FormKey fk = default;
        _fixture = new PluginFixtureBuilder("working-tree-change")
            .WithPlugin("Base.esm", mod => fk = mod.Npcs.AddNew("OriginalName").FormKey)
            .Build();
        _npcFormKey = fk;
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

    // EditorID is an identity column, not a reflected field (SchemaReflector.BaseSkip) — so this
    // reads the projection of the body that every listing, resolve and tree row is built from,
    // which is exactly the read-model-visible effect an edit has to produce.
    private static string EditorIdOf(RecordDocument document) =>
        document.EditorId ?? throw new InvalidOperationException("The fixture record has no EditorID.");

    [Fact]
    public void ApplyWorkingTreeChanges_EffectiveServesTheNewBody_WhileHeadKeepsTheCommittedOne()
    {
        using var index = LoadedIndex();
        var formKey = _npcFormKey.ToString();
        var committed = index.GetDocument(formKey, BaseKey)!;
        var editedBody = committed.Body!.Replace("OriginalName", "EditedName", StringComparison.Ordinal);
        Assert.NotEqual(committed.Body, editedBody); // the fixture really does carry the text being replaced

        index.ApplyWorkingTreeChanges(BaseKey, [(formKey, editedBody)]);

        var effective = index.GetDocument(formKey, BaseKey)!;
        Assert.Equal(editedBody, effective.Body);
        Assert.Equal("EditedName", EditorIdOf(effective));

        var head = index.At(RecordRef.Head).GetDocument(formKey, BaseKey)!;
        Assert.Equal(committed.Body, head.Body);
        Assert.Equal("OriginalName", EditorIdOf(head));
    }

    [Fact]
    public void ApplyWorkingTreeChanges_MarksTheOverrideStackEntryAsCarryingAWorkingTreeChange()
    {
        using var index = LoadedIndex();
        var formKey = _npcFormKey.ToString();
        var committed = index.GetDocument(formKey, BaseKey)!;

        var clean = index.GetOverrideStack(formKey)!.Entries.Single();
        Assert.False(clean.HasWorkingTreeChange);
        Assert.Equal(clean.Effective.Body, clean.Head.Body);

        index.ApplyWorkingTreeChanges(
            BaseKey, [(formKey, committed.Body!.Replace("OriginalName", "EditedName", StringComparison.Ordinal))]);

        var dirty = index.GetOverrideStack(formKey)!.Entries.Single();
        Assert.True(dirty.HasWorkingTreeChange);
        Assert.Equal("EditedName", EditorIdOf(dirty.Effective));
        Assert.Equal("OriginalName", EditorIdOf(dirty.Head));
    }

    [Fact]
    public void ApplyWorkingTreeChanges_EditingBackToTheCommittedBytes_ConvergesToClean()
    {
        using var index = LoadedIndex();
        var formKey = _npcFormKey.ToString();
        var committed = index.GetDocument(formKey, BaseKey)!;

        index.ApplyWorkingTreeChanges(
            BaseKey, [(formKey, committed.Body!.Replace("OriginalName", "EditedName", StringComparison.Ordinal))]);
        Assert.True(index.GetOverrideStack(formKey)!.Entries.Single().HasWorkingTreeChange);

        // Byte compare *is* the revert-convergence detection (#413 contract) — an edit back to the
        // committed bytes is not "a change that happens to match", it is no change at all.
        index.ApplyWorkingTreeChanges(BaseKey, [(formKey, committed.Body!)]);

        var reverted = index.GetOverrideStack(formKey)!.Entries.Single();
        Assert.False(reverted.HasWorkingTreeChange);
        Assert.Equal(committed.Body, reverted.Effective.Body);
        Assert.Equal(committed.Body, index.At(RecordRef.Head).GetDocument(formKey, BaseKey)!.Body);
    }
}
