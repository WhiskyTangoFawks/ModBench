using System.Drawing;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

/// <summary>One record per Color shape: Light (<c>wbByteColors</c>, an alpha on disk that must
/// survive a 3-leaf edit), the four <c>wbByteRGBA</c> records, and MaterialObject
/// (float storage).</summary>
public sealed class ColorCompileFixture : TestInstance
{
    public const string PluginName = "Color649.esp";
    private const string Origin = "Color649Mod";

    public string ModFolder => FolderOf(Origin);
    public PluginAddress Plugin { get; }

    // Neither 0 nor 255, so surviving a 3-leaf edit cannot pass by coincidence against a default.
    public const byte SeededLightAlpha = 137;

    public FormKey Light { get; }
    public FormKey Keyword { get; }
    public FormKey LocationReferenceType { get; }
    public FormKey ActionRecord { get; }
    public FormKey Location { get; }
    public FormKey MaterialObject { get; }

    public ColorCompileFixture()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

        var light = mod.Lights.AddNew("Light649");
        light.Color = Color.FromArgb(SeededLightAlpha, 10, 20, 30);
        Light = light.FormKey;

        var keyword = mod.Keywords.AddNew("Keyword649");
        keyword.Color = Color.FromArgb(1, 2, 3, 4);
        Keyword = keyword.FormKey;

        var locationReferenceType = mod.LocationReferenceTypes.AddNew("LocationReferenceType649");
        locationReferenceType.Color = Color.FromArgb(5, 6, 7, 8);
        LocationReferenceType = locationReferenceType.FormKey;

        var actionRecord = mod.Actions.AddNew("ActionRecord649");
        actionRecord.Color = Color.FromArgb(9, 10, 11, 12);
        ActionRecord = actionRecord.FormKey;

        var location = mod.Locations.AddNew("Location649");
        location.Color = Color.FromArgb(13, 14, 15, 16);
        Location = location.FormKey;

        // NoAlphaFloat: only R/G/B reach the binary at all, so the seeded alpha is irrelevant here
        // (Mutagen's own reader hands back alpha 0 for this shape — IBinaryStreamExt.cs:62-68).
        var materialObject = mod.MaterialObjects.AddNew("MaterialObject649");
        materialObject.SinglePassColor = Color.FromArgb(0, 60, 120, 180);
        MaterialObject = materialObject.FormKey;

        Plugin = Add(mod, Origin);
    }
}
