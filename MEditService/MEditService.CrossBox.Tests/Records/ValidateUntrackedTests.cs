using MEditService.Index;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Records;

/// <summary>ADR-0015 invariant 4 over the other system of record: an untracked copy's rows came from
/// its binary, which carries no unit smaller than itself, so validate reports and the projector
/// re-derives.</summary>
public sealed class ValidateUntrackedTests : IDisposable
{
    private readonly IndexedModFixture _mod = IndexedModFixture.Untracked();

    public void Dispose() => _mod.Dispose();

    private string PluginPath => Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName);

    private ValidationReport Validate() => Assert.Single(_mod.Index.ValidateIndex(_mod.Plugin));

    [Fact]
    public void AnUnchangedBinary_ValidatesClean()
    {
        var before = _mod.Index.Sequence;

        var report = Validate();

        Assert.False(report.NeedsRebuild);
        Assert.Empty(report.ChangedKeys);
        Assert.Equal(before, _mod.Index.Sequence);
    }

    [Fact]
    public void ABinaryRewrittenOutsideModbench_NeedsARebuild()
    {
        var rewritten = new Fallout4Mod(ModKey.FromFileName(IndexedModFixture.PluginName), Fallout4Release.Fallout4);
        rewritten.Npcs.AddNew("WrittenByAnotherTool");
        rewritten.WriteToBinary(PluginPath);

        var report = Validate();

        Assert.True(report.NeedsRebuild);
        Assert.Contains(_mod.Index.RequireReads().GetDocuments(_mod.Plugin), d => d.EditorId == "WrittenByAnotherTool");
    }

    [Fact]
    public void ABinaryDeletedOutsideModbench_TakesItsRowsWithIt()
    {
        File.Delete(PluginPath);

        var report = Validate();

        Assert.False(report.NeedsRebuild);
        Assert.Empty(_mod.Index.Projected().GetDocuments(_mod.Plugin));
    }
}
