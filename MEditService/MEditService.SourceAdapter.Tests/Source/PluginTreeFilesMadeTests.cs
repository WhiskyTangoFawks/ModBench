using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class PluginTreeFilesMadeTests
{
    private const string PluginName = "Made.esp";
    private const string CoinFormKey = "000801:Made.esp";
    private static readonly string CoinPath = Path.Combine("Globals", "Coin - 000801_Made.esp.json");

    private static PluginTreeFiles Made() =>
        PluginTreeFiles.Made(
            PluginName,
            [
                new TreeFile("RecordData.json", HeaderDocument.Write(new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4))),
                SpriggitMeta.Of(GameCodecs.For(GameRelease.Fallout4), ModKey.FromFileName(PluginName), GameRelease.Fallout4),
                new TreeFile(CoinPath, "{\n  \"FormKey\": \"000801:Made.esp\",\n  \"EditorID\": \"Coin\",\n  \"Weight\": 2\n}"u8.ToArray()),
            ],
            GameRelease.Fallout4).Value();

    [Fact]
    public void ARefusedDocument_IsNamedByTheRecordItHolds()
    {
        var tree = Made();

        var refused = Assert.Single(tree.RefusedFiles().Value());

        Assert.Equal(CoinFormKey, tree.Named(refused.Path));
    }

    [Fact]
    public void ADiagnosisOfARead_NamesTheRecordEachFileItCarriesHolds()
    {
        var read = new PluginDiagnosis(CoinPath, PluginDiagnosis.UnknownClass, null, $"Could not read {CoinPath}.");

        var named = Made().Named(read).Value();

        Assert.Equal((CoinFormKey, $"Could not read {CoinFormKey}."), (named.Anchor, named.Message));
    }

    [Fact]
    public void ARecord_IsInNoFile_AndIsNamedByItself()
    {
        var coin = new RecordIdentity(CoinFormKey, "glob", "Coin");
        var tree = Made();

        Assert.Equal(((string?)null, CoinFormKey), (tree.FileOf(coin).Value(), tree.Named(coin).Value()));
    }
}
