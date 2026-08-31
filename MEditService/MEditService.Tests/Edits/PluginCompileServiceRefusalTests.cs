using MEditService.Core.Edits;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Edits;

/// <summary>
/// A state compile structurally cannot emit is a typed refusal naming the reason, never an
/// exception and never a silently-corrupted binary.
/// </summary>
public sealed class PluginCompileServiceRefusalTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private PluginCompileService CompileService() =>
        new(_mod.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);

    [Fact]
    public void Compile_WithTwoSourceFilesClaimingTheSameFormKey_RefusesNamingTheFormKey()
    {
        // Two distinct source files, same FormKey — nothing the edit path can produce (a
        // rename/hand-edit/third-party tool could), and there is no way to emit it as two binary
        // records without changing one's FormKey.
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
    /// The same collision with both files in the <b>same group folder</b> — kept
    /// alive deliberately, because the compiled mod cannot be asked about it.
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
    /// never-assume-exclusive-ownership rule). Modbench's own half-completed rename is fixed; that did
    /// not make the state unreachable.</para>
    /// </summary>
    [Fact]
    public void Compile_WithTwoFilesInOneGroupFolderClaimingTheSameFormKey_RefusesNamingTheFormKey()
    {
        // Same group, same FormKey, a different EditorID in the file name — exactly what an interrupted
        // rename or a hand-copied file leaves behind.
        //
        // SourceFileFor resolves the record's real *current* file (FormKey-suffix matched,
        // blind to the EditorID argument) — exactly wrong for this test, which needs a synthetic,
        // not-yet-existing second name for the same FormKey. Computed directly through
        // SourceRecordPath.For with an out-of-range order index instead, so it can never coincide with
        // a real sibling's own index (collision detection matches on FormKey suffix alone regardless,
        // per SourceUnitResolver.NameCarries — the index is only here to keep this path visibly
        // synthetic).
        var npcSourceText = File.ReadAllText(_mod.NpcSourceFile);
        var duplicatePath = Path.Combine(_mod.ModFolder, SourceRecordPath.For(
            TrackedModFixture.PluginName, "npc_", _mod.Npc.ToString(), "CopyOfFixtureNpc", GameRelease.Fallout4,
            orderIndex: 99));
        Assert.NotEqual(_mod.NpcSourceFile, duplicatePath);
        File.WriteAllText(duplicatePath, npcSourceText);

        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Contains(_mod.Npc.ToString(), result.RefusalReason);
    }

    /// <summary>
    /// ADR-0042 amendment: source the codec cannot even parse — a hand edit that breaks the
    /// JSON, external corruption, anything that leaves the text not valid input to the deserializer
    /// at all — is a typed refusal pointing at re-Track, the same as every other thing this method
    /// cannot compile, never an unhandled exception surfacing as a bare 500.
    /// </summary>
    [Fact]
    public void Compile_WithUnparsableSourceFile_RefusesPointingAtReTrack()
    {
        File.WriteAllText(_mod.NpcSourceFile, "{ not valid json");

        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Contains("Re-Track", result.RefusalReason);
        Assert.Empty(result.Diagnostics);
        Assert.Empty(result.Masters);
    }

    /// <summary>
    /// ADR-0042 amendment: a breaking codec change with no migration, simulated without
    /// waiting for a real one. The generated deserializer is confirmed lenient in both directions —
    /// an unrecognized property is silently skipped
    /// (<c>kernel.Skip(reader)</c>) and a missing-but-expected one is silently left at its default —
    /// so deserializing succeeds either way, with nothing to notice the loss. Renaming a
    /// real field's key reproduces exactly that shape: the value is still on disk, but nothing reads
    /// it anymore, so it never survives being written back out.
    /// </summary>
    [Fact]
    public void Compile_WithSourceFieldRenamedToOneTheCodecNoLongerReads_RefusesNamingTheFile()
    {
        var npcSourceText = File.ReadAllText(_mod.NpcSourceFile);
        Assert.Contains("\"Race\"", npcSourceText);
        File.WriteAllText(_mod.NpcSourceFile, npcSourceText.Replace("\"Race\"", "\"RaceOld\""));

        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Contains("Re-Track", result.RefusalReason);
        Assert.Contains(TrackedModFixture.NpcEditorId, result.RefusalReason);
        Assert.Empty(result.Diagnostics);
        Assert.Empty(result.Masters);
    }
}
