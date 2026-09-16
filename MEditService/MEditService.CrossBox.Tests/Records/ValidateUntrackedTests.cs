using MEditService.Index;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Records;

/// <summary>ADR-0015 invariant 4 over the other system of record: an untracked copy's rows came from
/// its binary, which carries no unit smaller than itself, so validate reports and the caller
/// re-derives.</summary>
public sealed class ValidateUntrackedTests : IDisposable
{
    private readonly IndexedModFixture _mod = IndexedModFixture.Untracked();

    public void Dispose() => _mod.Dispose();

    private string PluginPath => Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName);

    private IRecordIndex Store => _mod.Index.Store
        ?? throw new InvalidOperationException("Expected the index projector to already hold a built store.");

    [Fact]
    public void AnUnchangedBinary_ValidatesClean()
    {
        var before = Store.Sequence;

        var report = Store.Validate(_mod.Plugin, _mod.ModFolder);

        Assert.False(report.NeedsRebuild);
        Assert.Empty(report.ChangedKeys);
        Assert.Equal(before, Store.Sequence);
    }

    [Fact]
    public void ABinaryRewrittenOutsideModbench_NeedsARebuild()
    {
        var rewritten = new Fallout4Mod(ModKey.FromFileName(IndexedModFixture.PluginName), Fallout4Release.Fallout4);
        rewritten.Npcs.AddNew("WrittenByAnotherTool");
        rewritten.WriteToBinary(PluginPath);

        var report = Store.Validate(_mod.Plugin, _mod.ModFolder);

        Assert.True(report.NeedsRebuild);
    }

    [Fact]
    public void ABinaryDeletedOutsideModbench_TakesItsRowsWithIt()
    {
        File.Delete(PluginPath);

        var report = Store.Validate(_mod.Plugin, _mod.ModFolder);

        Assert.False(report.NeedsRebuild);
        Assert.Empty(_mod.Index.Projected().GetDocuments(_mod.Plugin));
    }
}
