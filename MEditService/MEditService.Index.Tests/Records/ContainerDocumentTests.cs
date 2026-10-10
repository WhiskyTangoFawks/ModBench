using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Records;

[Collection(CutDownPluginCollection.Name)]
public sealed class ContainerDocumentTests(CutDownPluginFixture fixture)
{
    private static readonly string[] CellChildFields = ["Persistent", "Temporary", "NavigationMeshes", "Landscape"];

    private string? StoredBody(string formKey) =>
        fixture.Index.Queries.GetRenderedDocument(CutDownPluginFixture.Plugin, formKey).Value()?.Text;

    private static IModDisposeGetter OpenPlugin() => ModFactory.ImportGetter(
        new ModPath(ModKey.FromFileName(RealDataPlugin.PluginFileName), RealDataPlugin.PluginPath),
        GameRelease.Fallout4);

    [Fact]
    public void ACellWithChildren_HoldsThemEmbeddedInItsOwnDocument()
    {
        using var overlay = OpenPlugin();

        var withInlinedChildren = new List<(ICellGetter Cell, string[] Fields)>();
        foreach (var cell in overlay.EnumerateMajorRecords<ICellGetter>(throwIfUnknown: false))
        {
            using var doc = JsonDocument.Parse(RecordTextCodec.SerializeToText(cell, GameRelease.Fallout4));
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
    public void AContainersDocument_HoldsTheSameBytesTheSourcePathWould()
    {
        var setterMod = ModFactory.ImportSetter(
            new ModPath(ModKey.FromFileName(RealDataPlugin.PluginFileName), RealDataPlugin.PluginPath),
            GameRelease.Fallout4);

        var questMeasuredToHoldTopicsSpriggitDoesNotEmbed = setterMod.EnumerateMajorRecords<IQuest>().First(q => q.DialogTopics.Count > 0);

        var bytesATrackWritesToASourceFile = RecordTextCodec.SerializeToText(questMeasuredToHoldTopicsSpriggitDoesNotEmbed, GameRelease.Fallout4);

        var body = StoredBody(questMeasuredToHoldTopicsSpriggitDoesNotEmbed.FormKey.ToString());

        Assert.NotNull(body);
        Assert.Equal(bytesATrackWritesToASourceFile, body);
    }

    [Fact]
    public void ANonContainersDocument_HoldsTheCodecsBytesUnchanged()
    {
        using var overlay = OpenPlugin();

        var weapon = ((IFallout4ModGetter)overlay).Weapons.First();
        var expected = RecordTextCodec.SerializeToText(weapon, GameRelease.Fallout4);

        Assert.Equal(expected, StoredBody(weapon.FormKey.ToString()));
    }
}
