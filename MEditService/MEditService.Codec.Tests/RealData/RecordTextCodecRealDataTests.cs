using System.Diagnostics;
using MEditService.Codec.Serialization;
using MEditService.Codec.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Xunit.Abstractions;

namespace MEditService.Codec.Tests.RealData;

public class RecordTextCodecRealDataTests(ITestOutputHelper output)
{
    private const string AffectedWeaponEditorId = "VRWorkshopShared_AlienBlaster_NonPlayable";

    [Fact]
    public void OverlayAndDeepParse_SerializeToIdenticalText_OnARealWeaponAtThe0531PinWhere0540OverlayRegressionSplitsItsObjectTemplatesFrom2To3()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        using var overlayImport = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(RealDataPlugin.PluginFileName), RealDataPlugin.PluginPath),
            GameRelease.Fallout4);
        var deepParsedImport = ModFactory.ImportSetter(
            new ModPath(ModKey.FromFileName(RealDataPlugin.PluginFileName), RealDataPlugin.PluginPath),
            GameRelease.Fallout4);
        var overlay = (IFallout4ModGetter)overlayImport;
        var deepParsed = (IFallout4ModGetter)deepParsedImport;

        var overlayWeapon = overlay.Weapons.Single(w => w.EditorID == AffectedWeaponEditorId);
        var deepParsedWeapon = deepParsed.Weapons.Single(w => w.EditorID == AffectedWeaponEditorId);

        var overlayTemplateCount = overlayWeapon.ObjectTemplates?.Count ?? 0;
        var deepParsedTemplateCount = deepParsedWeapon.ObjectTemplates?.Count ?? 0;
        output.WriteLine($"Overlay ObjectTemplates: {overlayTemplateCount}, deep-parse ObjectTemplates: {deepParsedTemplateCount}");
        Assert.Equal(deepParsedTemplateCount, overlayTemplateCount);
        Assert.True(deepParsedTemplateCount > 0,
            "Expected this fixture weapon to carry ObjectTemplates content; pick a different affected weapon if it does not.");

        var swSerializeOverlay = Stopwatch.StartNew();
        var overlayBytes = codec.SerializeToBytes(overlayWeapon, GameRelease.Fallout4);
        swSerializeOverlay.Stop();

        var swSerializeDeep = Stopwatch.StartNew();
        var deepParsedBytes = codec.SerializeToBytes(deepParsedWeapon, GameRelease.Fallout4);
        swSerializeDeep.Stop();

        var swDeserialize = Stopwatch.StartNew();
        var roundTripped = (Weapon)codec.DeserializeFromBytes(deepParsedBytes, GameRelease.Fallout4, "weap");
        swDeserialize.Stop();

        output.WriteLine($"AC4: serialize (overlay) {swSerializeOverlay.ElapsedMilliseconds} ms, " +
            $"serialize (deep parse) {swSerializeDeep.ElapsedMilliseconds} ms, " +
            $"deserialize {swDeserialize.ElapsedMilliseconds} ms " +
            "(129 ms serialize / 55 ms deserialize measured on a 20 MB plugin).");

        Assert.Equal(deepParsedBytes, overlayBytes);

        var mask = deepParsedWeapon.GetEqualsMask(roundTripped);
        var leaves = MaskInspector.CountLeaves(mask).ToList();
        var divergent = leaves.Where(l => !l.Value).Select(l => l.Path).ToList();

        Assert.NotEmpty(leaves);
        Assert.Empty(divergent);
    }
}
