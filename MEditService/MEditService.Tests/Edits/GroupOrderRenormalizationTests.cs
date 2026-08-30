using MEditService.Core.Edits;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>
/// #489: any <see cref="RecordEditService.DeleteRecord"/> (and <see cref="RecordEditService.RenumberRecord"/>'s
/// own delete+create) used to leave a numbering gap in its touched group folder — deliberate,
/// documented behavior (#459/#427's own "gaps accepted by design" doctrine). <see cref="PluginCompileService"/>'s
/// round-trip gate (#473) regenerates canonical <c>"[N]"</c> prefixes as contiguous in-memory list
/// position, so that gap made every subsequent Save &amp; Compile refuse until the user re-Tracked —
/// for a completely benign reason, on the touched plugin's <i>own</i> next compile, with no container
/// involved at all.
///
/// <para>The fix: every structural write (<see cref="RecordEditService.DeleteRecord"/>,
/// <see cref="RecordEditService.RenumberRecord"/>, <see cref="RecordEditService.CreateRecord"/>) now
/// renormalizes its touched group folder to contiguous <c>[0..k]</c> as its own last file-system act
/// (<see cref="SourceUnitResolver.RenormalizeGroupOrder"/>). This suite proves the issue's own
/// repro no longer refuses, and that survivors' relative order and content both come through intact.
/// </para>
/// </summary>
public sealed class GroupOrderRenormalizationTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private RecordEditService EditService() =>
        new(_mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private PluginCompileService CompileService() =>
        new(_mod.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);

    private IFallout4ModGetter CompileAndReimport(out IDisposable handle)
    {
        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);
        var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(TrackedModFixture.PluginName), pluginPath), GameRelease.Fallout4);
        handle = overlay;
        return (IFallout4ModGetter)overlay;
    }

    private string NpcsDirectory =>
        Path.Combine(_mod.ModFolder, SourceRecordPath.RootFor(TrackedModFixture.PluginName), "Npcs");

    // ---- AC1: the issue's own repro ----

    [Fact]
    public void DeletingTheFirstOfTwoSameTypeRecords_ThenCompiling_Succeeds_AndTheBinaryReflectsTheDelete()
    {
        var deleted = EditService().DeleteRecord(_mod.Plugin, _mod.Npc.ToString());
        Assert.True(deleted.Applied, deleted.Message);

        var mod = CompileAndReimport(out var handle);
        using (handle)
        {
            Assert.DoesNotContain(mod.Npcs, n => n.FormKey == _mod.Npc);
            var survivor = Assert.Single(mod.Npcs);
            Assert.Equal(_mod.OtherNpc, survivor.FormKey);
            Assert.Equal(TrackedModFixture.OtherNpcEditorId, survivor.EditorID);
        }
    }

    [Fact]
    public void DeletingTheFirstOfTwo_RenormalizesTheGroupFolder_ToAContiguousSurvivorAtSlotZero()
    {
        var deleted = EditService().DeleteRecord(_mod.Plugin, _mod.Npc.ToString());
        Assert.True(deleted.Applied, deleted.Message);

        var names = Directory.GetFiles(NpcsDirectory).Select(Path.GetFileName).ToList();
        var survivor = Assert.Single(names);
        Assert.StartsWith("[0] " + TrackedModFixture.OtherNpcEditorId, survivor, StringComparison.Ordinal);
    }

    // ---- AC3a: renumber, flat ----

    [Fact]
    public void RenumberingTheFirstOfTwo_ThenCompiling_Succeeds_AndTheGroupFolderIsRenormalized()
    {
        var result = EditService().RenumberRecord(_mod.Plugin, _mod.Npc.ToString());
        Assert.True(result.Applied, result.Message);

        var names = Directory.GetFiles(NpcsDirectory).Select(Path.GetFileName).Order(StringComparer.Ordinal).ToList();
        Assert.Equal(2, names.Count);
        // The untouched survivor renormalized down to slot 0 (it was at slot 1)...
        Assert.Contains(names, n => n!.StartsWith("[0] " + TrackedModFixture.OtherNpcEditorId, StringComparison.Ordinal));
        // ...and the renumbered record appended at the end (slot 1), not left at a gapped slot 2.
        Assert.Contains(names, n => n!.StartsWith("[1] " + TrackedModFixture.NpcEditorId, StringComparison.Ordinal));

        var mod = CompileAndReimport(out var handle);
        using (handle)
        {
            Assert.DoesNotContain(mod.Npcs, n => n.FormKey == _mod.Npc);
            Assert.Contains(mod.Npcs, n => n.FormKey.ToString() == result.NewFormKey);
            Assert.Contains(mod.Npcs, n => n.FormKey == _mod.OtherNpc);
        }
    }

    // ---- AC3b: delete inside a container-nested folder-split list ----

    [Fact]
    public void DeletingTheMiddleOfThreeDialogTopics_ThenCompiling_Succeeds_KeepingSurvivorsInOrder()
    {
        using var container = new ContainerModFixture();
        var editService = new RecordEditService(container.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);
        var compileService = new PluginCompileService(
            container.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);

        var deleted = editService.DeleteRecord(container.Plugin, container.DialogTopic2.ToString());
        Assert.True(deleted.Applied, deleted.Message);

        // Before #489 this refused: "does not round-trip through its own source ... Re-Track".
        var result = compileService.Compile(container.Plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(container.ModFolder, ContainerModFixture.PluginName);
        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(ContainerModFixture.PluginName), pluginPath), GameRelease.Fallout4);
        var mod = (IFallout4ModGetter)overlay;

        var quest = mod.Quests.Single(q => q.FormKey == container.Quest);
        Assert.Equal(
            [ContainerModFixture.DialogTopicEditorId, ContainerModFixture.DialogTopic3EditorId],
            quest.DialogTopics.Select(t => t.EditorID!).ToArray());
    }

    // ---- CreateRecord's own defensive renormalization ----

    /// <summary>
    /// CreateRecord renormalizes its own group folder too, defensively — never-assume-exclusive-
    /// ownership means a gap can already be there for a reason nothing in this process caused (a
    /// hand-deleted sibling file, another tool's edit), and this proves Create closes it rather than
    /// merely not making it worse.
    /// </summary>
    [Fact]
    public void CreatingARecord_ClosesAPreExistingExternalGap_NotJustAppendingPastIt()
    {
        // Simulate an externally-introduced gap without going through DeleteRecord (which would close
        // it itself) — hand-delete the tracked [0] file directly, the way another tool could.
        var npcFile = _mod.NpcSourceFile;
        Assert.StartsWith(Path.Combine(NpcsDirectory, "[0]"), npcFile, StringComparison.Ordinal);
        File.Delete(npcFile);

        var created = EditService().CreateRecord(_mod.Plugin, "npc_", "BrandNew");
        Assert.True(created.Applied, created.Message);

        var names = Directory.GetFiles(NpcsDirectory).Select(Path.GetFileName).Order(StringComparer.Ordinal).ToList();
        Assert.Equal(2, names.Count);
        Assert.Contains(names, n => n!.StartsWith("[0] " + TrackedModFixture.OtherNpcEditorId, StringComparison.Ordinal));
        Assert.Contains(names, n => n!.StartsWith("[1] BrandNew", StringComparison.Ordinal));
    }

    // ---- AC5: stacked operations, no drift ----

    [Fact]
    public void StackedDeletesAndCreates_StillCompile_WithNoAccumulatedDrift()
    {
        var service = EditService();

        var created1 = service.CreateRecord(_mod.Plugin, "npc_", "Created1");
        var created2 = service.CreateRecord(_mod.Plugin, "npc_", "Created2");
        Assert.True(created1.Applied, created1.Message);
        Assert.True(created2.Applied, created2.Message);

        var deleted1 = service.DeleteRecord(_mod.Plugin, _mod.Npc.ToString());
        Assert.True(deleted1.Applied, deleted1.Message);

        var renumbered = service.RenumberRecord(_mod.Plugin, _mod.OtherNpc.ToString());
        Assert.True(renumbered.Applied, renumbered.Message);

        var deleted2 = service.DeleteRecord(_mod.Plugin, FormKey.Factory(created1.NewFormKey!).ToString());
        Assert.True(deleted2.Applied, deleted2.Message);

        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);
        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(TrackedModFixture.PluginName), pluginPath), GameRelease.Fallout4);
        var mod = (IFallout4ModGetter)overlay;

        // Survivors: the renumbered OtherNpc (new FormKey) and Created2. Npc and Created1 are gone.
        Assert.Equal(2, mod.Npcs.Count);
        Assert.Contains(mod.Npcs, n => n.FormKey.ToString() == renumbered.NewFormKey);
        Assert.Contains(mod.Npcs, n => n.EditorID == "Created2");
        Assert.DoesNotContain(mod.Npcs, n => n.FormKey == _mod.Npc);
        Assert.DoesNotContain(mod.Npcs, n => n.FormKey.ToString() == created1.NewFormKey);
    }
}
