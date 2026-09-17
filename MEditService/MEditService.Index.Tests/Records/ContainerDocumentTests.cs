using System.Text;
using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

/// <summary>The scope of "embedded" is Spriggit's, so a quest's document carries none of its
/// topics. Subjects are measured, since a hardcoded FormKey would decay silently.</summary>
public sealed class ContainerDocumentTests(CutDownPluginFixture fixture) : IClassFixture<CutDownPluginFixture>
{
    private static readonly string[] CellChildFields = ["Persistent", "Temporary", "NavigationMeshes", "Landscape"];
    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);

    private string? StoredBody(string formKey) =>
        fixture.Reads.GetDocument(formKey, CutDownPluginFixture.Plugin)?.Body;

    private static IModDisposeGetter OpenPlugin() => ModFactory.ImportGetter(
        new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath),
        GameRelease.Fallout4);

    [Fact]
    public async Task Index_ForACellWithChildren_StoresThemEmbeddedInTheCellsOwnDocument()
    {
        using var overlay = OpenPlugin();

        var withInlinedChildren = new List<(ICellGetter Cell, string[] Fields)>();
        foreach (var cell in overlay.EnumerateMajorRecords<ICellGetter>(throwIfUnknown: false))
        {
            using var doc = JsonDocument.Parse(await Codec.SerializeToBytesAsync(cell, GameRelease.Fallout4));
            var present = CellChildFields.Where(f => doc.RootElement.TryGetProperty(f, out _)).ToArray();
            if (present.Length > 0) withInlinedChildren.Add((cell, present));
        }

        Assert.True(withInlinedChildren.Count > 0,
            "Positive control: at least one cell in the corpus must carry embedded children when " +
            "serialized, or this test proves nothing about storing them.");

        var missing = new List<string>();
        foreach (var (cell, expected) in withInlinedChildren)
        {
            var body = StoredBody(cell.FormKey.ToString());
            Assert.NotNull(body);
            using var stored = JsonDocument.Parse(body);
            foreach (var field in expected)
            {
                if (!stored.RootElement.TryGetProperty(field, out _))
                    missing.Add($"{cell.FormKey}.{field}");
            }
        }

        Assert.Empty(missing);
    }

    [Fact]
    public async Task Index_ForAContainer_StoresTheSameBytesTheSourcePathWould()
    {
        var setterMod = ModFactory.ImportSetter(
            new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath),
            GameRelease.Fallout4);

        var quest = setterMod.EnumerateMajorRecords<IQuest>().First(q => q.DialogTopics.Count > 0);

        // Exactly what a Track writes into a source file — which is nothing but the codec call itself.
        var sourceBytes = await Codec.SerializeToBytesAsync(quest, GameRelease.Fallout4);

        var body = StoredBody(quest.FormKey.ToString());

        Assert.NotNull(body);
        Assert.Equal(Encoding.UTF8.GetString(sourceBytes), body);
    }

    [Fact]
    public async Task Index_ForANonContainer_StoresTheCodecsBytesUnchanged()
    {
        using var overlay = OpenPlugin();

        var weapon = ((IFallout4ModGetter)overlay).Weapons.First();
        var expected = await Codec.SerializeToBytesAsync(weapon, GameRelease.Fallout4);

        Assert.Equal(Encoding.UTF8.GetString(expected), StoredBody(weapon.FormKey.ToString()));
    }
}
