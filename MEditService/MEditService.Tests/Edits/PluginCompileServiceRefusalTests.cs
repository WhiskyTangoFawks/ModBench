using MEditService.Core.Edits;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>
/// #416 S4: a state compile structurally cannot emit is a typed refusal naming the reason, never an
/// exception and never a silently-corrupted binary.
/// </summary>
public sealed class PluginCompileServiceRefusalTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private PluginCompileService CompileService() =>
        new(_mod.Sessions, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);

    [Fact]
    public void Compile_WithTwoSourceFilesClaimingTheSameFormKey_RefusesNamingTheFormKey()
    {
        // Two distinct source files, same FormKey — nothing this arc's edit path can produce (a
        // rename/hand-edit/third-party tool could), and there is no way to emit it as two binary
        // records without changing one's FormKey (#416 comment 2 on the issue).
        var npcSourceText = File.ReadAllText(_mod.NpcSourceFile);
        var collidingPath = _mod.SourceFileFor(_mod.Npc, "keyword");
        Directory.CreateDirectory(Path.GetDirectoryName(collidingPath)!);
        File.WriteAllText(collidingPath, npcSourceText);

        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Contains(_mod.Npc.ToString(), result.RefusalReason);
        Assert.Empty(result.Diagnostics);
        Assert.Empty(result.Masters);
    }
}
