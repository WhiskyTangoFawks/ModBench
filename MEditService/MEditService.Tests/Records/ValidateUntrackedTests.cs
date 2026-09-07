using MEditService.Core.Records;
using MEditService.Tests.Edits;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Records;

/// <summary>ADR-0046 invariant 6 over the other system of record: an untracked copy's rows came from
/// its binary, which carries no unit smaller than itself, so validate reports and the caller
/// re-derives.</summary>
public sealed class ValidateUntrackedTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Untracked();

    public void Dispose() => _mod.Dispose();

    private string PluginPath => Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);

    [Fact]
    public void AnUnchangedBinary_ValidatesClean()
    {
        var before = _mod.Mirror.Index!.Sequence;

        var report = _mod.Mirror.Index!.Validate(_mod.Plugin, _mod.ModFolder);

        Assert.False(report.NeedsRebuild);
        Assert.Empty(report.ChangedKeys);
        Assert.Equal(before, _mod.Mirror.Index!.Sequence);
    }

    [Fact]
    public void ABinaryRewrittenOutsideModbench_NeedsARebuild()
    {
        var rewritten = new Fallout4Mod(ModKey.FromFileName(TrackedModFixture.PluginName), Fallout4Release.Fallout4);
        rewritten.Npcs.AddNew("WrittenByAnotherTool");
        rewritten.WriteToBinary(PluginPath);

        var report = _mod.Mirror.Index!.Validate(_mod.Plugin, _mod.ModFolder);

        Assert.True(report.NeedsRebuild);
    }

    [Fact]
    public void ABinaryDeletedOutsideModbench_TakesItsRowsWithIt()
    {
        File.Delete(PluginPath);

        var report = _mod.Mirror.Index!.Validate(_mod.Plugin, _mod.ModFolder);

        Assert.False(report.NeedsRebuild);
        Assert.Empty(_mod.Mirror.Index!.At(RecordRef.Effective).GetDocuments(_mod.Plugin));
    }
}
