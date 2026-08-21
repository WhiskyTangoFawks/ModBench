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
        var collidingPath = _mod.SourceFileFor(_mod.Npc, "keyword", TrackedModFixture.NpcEditorId);
        Directory.CreateDirectory(Path.GetDirectoryName(collidingPath)!);
        File.WriteAllText(collidingPath, npcSourceText);

        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Contains(_mod.Npc.ToString(), result.RefusalReason);
        Assert.Empty(result.Diagnostics);
        Assert.Empty(result.Masters);
    }

    /// <summary>
    /// The same collision with both files in the <b>same group folder</b> — the case #454 had to keep
    /// alive deliberately, because the compiled mod can no longer be asked about it.
    ///
    /// <para>Since compile reads the tree through the whole-mod door, every group ends its read with
    /// <c>group.RecordCache.SetTo(x =&gt; x.FormKey, records)</c> — a FormKey-keyed cache. Two files in
    /// one folder claiming one FormKey therefore collapse to whichever the reader read last,
    /// <i>silently</i>, before compile sees the mod at all: a record the user can see in their tree and
    /// cannot find in the compiled plugin, with no diagnostic. So the question is asked of the tree
    /// (<c>SourceUnitResolver.FormKeysWithMoreThanOneSourceUnit</c>) rather than of the mod, and this is
    /// the test that stops that quietly regressing to a duplicate scan over the mod — which passes the
    /// case above and fails this one.</para>
    ///
    /// <para>Reachable without Modbench's help: another tool duplicating a file, a partially restored
    /// backup, or a user copying a record file to experiment (root CLAUDE.md's
    /// never-assume-exclusive-ownership rule). #453 fixed Modbench's own half-completed rename; it did
    /// not make the state unreachable.</para>
    /// </summary>
    [Fact]
    public void Compile_WithTwoFilesInOneGroupFolderClaimingTheSameFormKey_RefusesNamingTheFormKey()
    {
        // Same group, same FormKey, a different EditorID in the file name — exactly what an interrupted
        // rename or a hand-copied file leaves behind.
        var npcSourceText = File.ReadAllText(_mod.NpcSourceFile);
        var duplicatePath = _mod.SourceFileFor(_mod.Npc, "npc_", "CopyOfFixtureNpc");
        Assert.NotEqual(_mod.NpcSourceFile, duplicatePath);
        File.WriteAllText(duplicatePath, npcSourceText);

        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Contains(_mod.Npc.ToString(), result.RefusalReason);
    }
}
