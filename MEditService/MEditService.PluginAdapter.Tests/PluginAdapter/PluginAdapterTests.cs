using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.PluginAdapter;

// ADR-0005 rule 2: the verbs a plugin's bytes reach a live Mutagen mod through, and go back to
// bytes through, driven at IPluginAdapter and PluginWriter rather than the adapter's own internals.
public sealed class PluginAdapterTests
{
    private const string PluginName = "Adapter.esp";

    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static PluginFixtureData TwoNpcPlugin(string prefix) =>
        new PluginFixtureBuilder(prefix)
            .WithPlugin(PluginName, mod =>
            {
                mod.Npcs.AddNew("AdapterNpc01");
                mod.Npcs.AddNew("AdapterNpc02");
            })
            .Build();

    private static ModPath PathOf(PluginFixtureData data) =>
        new(ModKey.FromFileName(PluginName), Path.Combine(data.DataFolder, PluginName));

    private static string EditorIdOf(string documentText) =>
        JsonDocument.Parse(documentText).RootElement.GetProperty("EditorID").GetString()
        ?? throw new InvalidOperationException("Expected the document to carry an EditorID.");

    [Fact]
    public void OpenDocuments_ReadsTheRecordsThePluginCarries_UnderTheModKeyItsNameGives()
    {
        using var data = TwoNpcPlugin("adapter-read");

        using var documents = Adapter.OpenDocuments(PathOf(data), GameRelease.Fallout4, Schemas);
        var npcs = documents.Records.Where(r => r.RecordType == "npc_").ToList();

        Assert.Equal(
            ["AdapterNpc01", "AdapterNpc02"],
            npcs.Select(r => EditorIdOf(r.Text)).Order(StringComparer.Ordinal));
        Assert.All(npcs, r => Assert.EndsWith($":{PluginName}", r.FormKey, StringComparison.Ordinal));
    }

    [Fact]
    public async Task CreateAndWriteAsync_CarriesTheReleaseAndKeyItWasGiven_AndNoRecords()
    {
        var scratch = Directory.CreateTempSubdirectory("medit-adapter-create-").FullName;
        try
        {
            var path = Path.Combine(scratch, PluginName);

            await Adapter.CreateAndWriteAsync(ModKey.FromFileName(PluginName), path, GameRelease.Fallout4, smallMaster: false);

            using var reread = Fallout4Mod.CreateFromBinaryOverlay(
                new ModPath(ModKey.FromFileName(PluginName), path), Fallout4Release.Fallout4);
            Assert.Equal(ModKey.FromFileName(PluginName), reread.ModKey);
            Assert.Equal(GameRelease.Fallout4, reread.GameRelease);
            Assert.Empty(reread.EnumerateMajorRecords());

            // ADR-0006: the header's stored NextObjectID is written as stored, not re-derived.
            var freshDefault = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4)
                .ModHeader.Stats.NextFormID;
            Assert.Equal(freshDefault, reread.ModHeader.Stats.NextFormID);
        }
        finally
        {
            Directory.Delete(scratch, recursive: true);
        }
    }

    // ADR-0008: the caller's order is the written order, not Mutagen's undefined default.
    [Fact]
    public async Task SaveAsync_WithALoadOrder_WritesTheMasterListInThatOrder()
    {
        using var data = new PluginFixtureBuilder("adapter-masters")
            .WithPlugin("AlphaBase.esm", mod => mod.Npcs.AddNew("AlphaNpc"))
            .WithPlugin("BetaBase.esm", mod => mod.Npcs.AddNew("BetaNpc"))
            .WithPlugin("Patch.esp", (mod, built) =>
            {
                foreach (var npc in built.SelectMany(b => b.Npcs))
                    mod.Npcs.GetOrAddAsOverride(npc);
            })
            .Build();
        var patchPath = Path.Combine(data.DataFolder, "Patch.esp");
        var reversed = new[] { "BetaBase.esm", "AlphaBase.esm" };

        using (var natural = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("Patch.esp"), patchPath), Fallout4Release.Fallout4))
        {
            Assert.NotEqual(reversed, natural.ModHeader.MasterReferences.Select(m => m.Master.FileName.ToString()));
        }

        var writer = new PluginWriter(NullLogger<PluginWriter>.Instance);
        await writer.SaveAsync(patchPath, GameRelease.Fallout4, reversed);

        using var reread = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("Patch.esp"), patchPath), Fallout4Release.Fallout4);
        Assert.Equal(reversed, reread.ModHeader.MasterReferences.Select(m => m.Master.FileName.ToString()));
    }
}
