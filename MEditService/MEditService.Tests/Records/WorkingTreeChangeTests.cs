using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Records;

/// <summary>Bodies are real codec documents edited as text, not hand-written JSON: the invariant is
/// "Body bytes = the source file's bytes at that ref", so a fabricated body would test a shape the
/// codec never emits.</summary>
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
        index.IndexMod(Fallout4Mod.CreateFromBinaryOverlay(path, Fallout4Release.Fallout4), Registration.Participating(0), BaseKey);
        index.UpdateWinners();
        return index;
    }

    // EditorID is an identity column, not a reflected field, so this reads the projection of the
    // body every listing, resolve and tree row is built from.
    private static string EditorIdOf(RecordDocument document) =>
        document.EditorId ?? throw new InvalidOperationException("The fixture record has no EditorID.");

    [Fact]
    public void ProjectDocuments_EffectiveServesTheNewBody_WhileHeadKeepsTheCommittedOne()
    {
        using var index = LoadedIndex();
        var formKey = _npcFormKey.ToString();
        var committed = index.At(RecordRef.Effective).GetDocument(formKey, BaseKey)!;
        var editedBody = committed.Body!.Replace("OriginalName", "EditedName", StringComparison.Ordinal);
        Assert.NotEqual(committed.Body, editedBody); // the fixture really does carry the text being replaced

        index.ProjectDocuments(BaseKey, [(formKey, editedBody)]);

        var effective = index.At(RecordRef.Effective).GetDocument(formKey, BaseKey)!;
        Assert.Equal(editedBody, effective.Body);
        Assert.Equal("EditedName", EditorIdOf(effective));

        var head = index.At(RecordRef.Head).GetDocument(formKey, BaseKey)!;
        Assert.Equal(committed.Body, head.Body);
        Assert.Equal("OriginalName", EditorIdOf(head));
    }

    [Fact]
    public void ProjectDocuments_MarksTheOverrideStackEntryAsCarryingAWorkingTreeChange()
    {
        using var index = LoadedIndex();
        var formKey = _npcFormKey.ToString();
        var committed = index.At(RecordRef.Effective).GetDocument(formKey, BaseKey)!;

        var clean = index.At(RecordRef.Effective).GetOverrideStack(formKey)!.Entries.Single();
        Assert.False(clean.HasWorkingTreeChange);
        Assert.Equal(clean.Effective.Body, clean.Head.Body);

        index.ProjectDocuments(
            BaseKey, [(formKey, committed.Body!.Replace("OriginalName", "EditedName", StringComparison.Ordinal))]);

        var dirty = index.At(RecordRef.Effective).GetOverrideStack(formKey)!.Entries.Single();
        Assert.True(dirty.HasWorkingTreeChange);
        Assert.Equal("EditedName", EditorIdOf(dirty.Effective));
        Assert.Equal("OriginalName", EditorIdOf(dirty.Head));
    }

    [Fact]
    public void ProjectDocuments_EditingBackToTheCommittedBytes_ConvergesToClean()
    {
        using var index = LoadedIndex();
        var formKey = _npcFormKey.ToString();
        var committed = index.At(RecordRef.Effective).GetDocument(formKey, BaseKey)!;

        index.ProjectDocuments(
            BaseKey, [(formKey, committed.Body!.Replace("OriginalName", "EditedName", StringComparison.Ordinal))]);
        Assert.True(index.At(RecordRef.Effective).GetOverrideStack(formKey)!.Entries.Single().HasWorkingTreeChange);

        // Byte compare *is* the revert-convergence detection — an edit back to the
        // committed bytes is not "a change that happens to match", it is no change at all.
        index.ProjectDocuments(BaseKey, [(formKey, committed.Body!)]);

        var reverted = index.At(RecordRef.Effective).GetOverrideStack(formKey)!.Entries.Single();
        Assert.False(reverted.HasWorkingTreeChange);
        Assert.Equal(committed.Body, reverted.Effective.Body);
        Assert.Equal(committed.Body, index.At(RecordRef.Head).GetDocument(formKey, BaseKey)!.Body);
    }
}
