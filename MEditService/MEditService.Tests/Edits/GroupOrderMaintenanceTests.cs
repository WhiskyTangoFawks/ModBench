using MEditService.Core.Edits;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>Every structural write leaves the touched group's ordered child list agreeing with the
/// files beside it, so the next Save &amp; Compile succeeds (ADR-0042 decision 4).</summary>
public sealed class GroupOrderMaintenanceTests : IDisposable
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

    private List<string> NpcFiles() =>
        [.. Directory.GetFiles(NpcsDirectory)
            .Select(Path.GetFileName)
            .Where(n => !string.Equals(n, "GroupRecordData.json", StringComparison.Ordinal))
            .Select(n => n!)
            .Order(StringComparer.Ordinal)];

    private IReadOnlyList<string> NpcOrder() =>
        SourceChildOrder.ListAt(SourceChildOrder.CarrierFor(NpcsDirectory, parentIsRecord: false), "Npcs");

    // ---- the original repro ----

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
    public void DeletingTheFirstOfTwo_LeavesTheSurvivorsFileUntouched_AndDropsOneLineFromTheParent()
    {
        var survivorNameBefore = NpcFiles()
            .Single(n => n.StartsWith(TrackedModFixture.OtherNpcEditorId, StringComparison.Ordinal));

        var deleted = EditService().DeleteRecord(_mod.Plugin, _mod.Npc.ToString());
        Assert.True(deleted.Applied, deleted.Message);

        // The survivor was second and is now the only one — and its file was not renamed for it,
        // which is the whole point of the amendment.
        var survivor = Assert.Single(NpcFiles());
        Assert.Equal(survivorNameBefore, survivor);

        Assert.Equal([_mod.OtherNpc.ToString()], NpcOrder());
    }

    // ---- renumber, flat ----

    [Fact]
    public void RenumberingTheFirstOfTwo_ThenCompiling_Succeeds_AndTheRecordKeepsItsPosition()
    {
        var result = EditService().RenumberRecord(_mod.Plugin, _mod.Npc.ToString());
        Assert.True(result.Applied, result.Message);

        var names = NpcFiles();
        Assert.Equal(2, names.Count);
        // The renumbered record stays first, under its new FormKey — a renumber repoints the parent's
        // list entry in place rather than appending, so the untouched sibling never moves either.
        Assert.Equal([result.NewFormKey!, _mod.OtherNpc.ToString()], NpcOrder());

        var mod = CompileAndReimport(out var handle);
        using (handle)
        {
            Assert.DoesNotContain(mod.Npcs, n => n.FormKey == _mod.Npc);
            Assert.Contains(mod.Npcs, n => n.FormKey.ToString() == result.NewFormKey);
            Assert.Contains(mod.Npcs, n => n.FormKey == _mod.OtherNpc);
        }
    }

    // ---- delete inside a quest's embedded list ----

    [Fact]
    public void DeletingTheMiddleOfThreeDialogTopics_ThenCompiling_Succeeds_KeepingSurvivorsInOrder()
    {
        using var container = new ContainerModFixture();
        var editService = new RecordEditService(container.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);
        var compileService = new PluginCompileService(
            container.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);

        var deleted = editService.DeleteRecord(container.Plugin, container.DialogTopic2.ToString());
        Assert.True(deleted.Applied, deleted.Message);

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

    [Fact]
    public void CreatingARecord_AfterAnExternalHandDelete_Succeeds_AndCompileRefusesNamingTheStaleList()
    {
        File.Delete(_mod.NpcSourceFile);

        var created = EditService().CreateRecord(_mod.Plugin, "npc_", "BrandNew");
        Assert.True(created.Applied, created.Message);

        var names = NpcFiles();
        Assert.Equal(2, names.Count);
        Assert.Contains(names, n => n.StartsWith(TrackedModFixture.OtherNpcEditorId, StringComparison.Ordinal));
        Assert.Contains(names, n => n.StartsWith("BrandNew", StringComparison.Ordinal));

        var compile = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());
        Assert.False(compile.Succeeded);
        Assert.Contains(Path.Combine("Npcs", "GroupRecordData.json"), compile.RefusalReason, StringComparison.Ordinal);
    }

    // ---- stacked operations, no drift ----

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
