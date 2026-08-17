using MEditService.Core.Edits;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Changes;

/// <summary>
/// A plugin's masters are wholly content-derived at write time, unconditionally, on every save
/// (#337/ADR-0038) — there is no longer any way to stage a direct edit to the header's masters
/// field (#335/#336), so the writer no longer special-cases anything about it: Mutagen's default
/// content-sync (Iterate) always runs, and the written order is set explicitly to the session's
/// current plugin load order rather than left to Mutagen's undefined default.
/// </summary>
public sealed class PluginWriterMastersTests
{
    private static readonly ISchemaReflector Reflector = SharedSchemaReflector.Instance;

    private static PendingChange AuthorChange(string plugin) =>
        new(Guid.NewGuid(), $"000000:{plugin}", plugin, "author", "header",
            System.Text.Json.JsonDocument.Parse("null").RootElement.Clone(),
            System.Text.Json.JsonDocument.Parse("\"New Author\"").RootElement.Clone(),
            "user", null, DateTime.UtcNow, "field_edit", null,
            null, null, null, null, "Data");

    // --- AC1: a committed master no longer referenced by any content is dropped, on every save
    // (not scoped to any particular field — there is nothing left to scope it by). ---

    [Fact]
    public async Task SaveAsync_UnreferencedDeclaredMaster_IsPrunedOnEverySave()
    {
        var data = new PluginFixtureBuilder("pw-masters-prune")
            .WithPlugin(
                "Active.esp",
                mod =>
                {
                    mod.ModHeader.Author = "Original Author";
                    ((IMod)mod).MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Fallout4.esm") });
                },
                // Preserve the unreferenced declared master through the *fixture's own* build
                // write, so the plugin genuinely starts with it declared before the write-under-test.
                writeParams: new Mutagen.Bethesda.Plugins.Binary.Parameters.BinaryWriteParameters
                {
                    MastersListContent = Mutagen.Bethesda.Plugins.Binary.Parameters.MastersListContentOption.NoCheck,
                })
            .Build();
        using var _ = data;
        var pluginPath = Path.Combine(data.DataFolder, "Active.esp");
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        // Nothing in the content references "Fallout4.esm" — an ordinary author edit, no masters
        // field touched at all, still prunes it via Mutagen's default Iterate sync.
        var result = await writer.SaveAsync(pluginPath, [AuthorChange("Active.esp")], GameRelease.Fallout4);

        Assert.Contains("author", result.Applied);

        using var saved = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("Active.esp"), pluginPath), Fallout4Release.Fallout4);
        Assert.Empty(saved.MasterReferences);
    }

    // --- AC2: content referencing a plugin never declared as a master gets it added, with no
    // masters field touched at all — proving the sync is truly content-driven, not edit-driven. ---

    [Fact]
    public async Task SaveAsync_ContentReferencesUndeclaredPlugin_AddsItAsMaster()
    {
        var data = new PluginFixtureBuilder("pw-masters-add")
            .WithPlugin("Master.esm", mod => mod.Npcs.AddNew("MasterNpc"))
            .WithPlugin("Active.esp", (mod, priorMods) =>
            {
                mod.ModHeader.Author = "Original Author";
                // Active.esp never declares Master.esm — this override is the only thing that
                // references it, and it happens purely in memory (no fixture-time master
                // declaration), mirroring what a real copy-as-override staged edit produces.
                var masterNpc = priorMods[0].Npcs.First();
                mod.Npcs.GetOrAddAsOverride(masterNpc);
            })
            .Build();
        using var _ = data;
        var pluginPath = Path.Combine(data.DataFolder, "Active.esp");
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(pluginPath, [AuthorChange("Active.esp")], GameRelease.Fallout4);

        Assert.Contains("author", result.Applied);

        using var saved = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("Active.esp"), pluginPath), Fallout4Release.Fallout4);
        Assert.Equal(["Master.esm"], saved.MasterReferences.Select(r => r.Master.FileName.ToString()));
    }

    // --- AC3: the written master list's order matches the given load order, not Mutagen's default
    // (alphabetical, masters-first) — pinned with deliberately shuffled input. ---

    [Fact]
    public async Task SaveAsync_MastersOrder_FollowsGivenLoadOrder_NotAlphabetical()
    {
        var data = new PluginFixtureBuilder("pw-masters-order")
            .WithPlugin("AAA.esm", mod => mod.Npcs.AddNew("AaaNpc"))
            .WithPlugin("BBB.esm", mod => mod.Npcs.AddNew("BbbNpc"))
            .WithPlugin("Active.esp", (mod, priorMods) =>
            {
                mod.ModHeader.Author = "Original Author";
                mod.Npcs.GetOrAddAsOverride(priorMods[0].Npcs.First()); // AAA.esm
                mod.Npcs.GetOrAddAsOverride(priorMods[1].Npcs.First()); // BBB.esm
            })
            .Build();
        using var _ = data;
        var pluginPath = Path.Combine(data.DataFolder, "Active.esp");
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        // Alphabetical (Mutagen's unset-ordering default) would be AAA, BBB — the given load
        // order deliberately reverses that.
        var result = await writer.SaveAsync(
            pluginPath, [AuthorChange("Active.esp")], GameRelease.Fallout4,
            loadOrder: ["BBB.esm", "AAA.esm", "Active.esp"]);

        Assert.Contains("author", result.Applied);

        using var saved = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("Active.esp"), pluginPath), Fallout4Release.Fallout4);
        Assert.Equal(["BBB.esm", "AAA.esm"], saved.MasterReferences.Select(r => r.Master.FileName.ToString()));
    }
}
