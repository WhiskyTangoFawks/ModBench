using System.Drawing;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>
/// One real mod folder, tracked once, holding one record per Color-carrying shape #649 needs to
/// prove — the same "one shared small mod, many facts" shape <see cref="AbstractUnionCompileFixture"/>
/// established, and for the same reason: the expensive part is the
/// <see cref="LoadOrderMirror"/>/<see cref="TrackService"/> setup, not the records.
///
/// <para>The six records cover the three cases that behave differently on the wire:
/// <list type="bullet">
/// <item><b>Light</b> — <c>ColorBinaryType.Alpha</c>, but rendered by xEdit's <c>wbByteColors</c>
/// (3 leaves). Its alpha byte exists on disk and must survive a red/green/blue-only edit untouched.
/// Seeded with a non-255 alpha precisely so "preserved" is distinguishable from "defaulted".</item>
/// <item><b>Keyword / LocationReferenceType / ActionRecord / Location</b> — the whole
/// <c>SchemaReflector.AlphaBearingColorFields</c> allowlist, xEdit's <c>wbByteRGBA</c> (4 leaves).
/// One record each so every row of a hand-transcribed table gets its own compile proof rather than
/// one representative standing in for four.</item>
/// <item><b>MaterialObject</b> — <c>ColorBinaryType.NoAlphaFloat</c>, the float-encoded storage
/// whose byte&lt;-&gt;float quantization <see cref="ColorQuantizationTests"/> analyses in the
/// abstract. This is that analysis against a real compile.</item>
/// </list></para>
/// </summary>
public sealed class ColorCompileFixture : IDisposable
{
    public const string PluginName = "Color649.esp";
    private const string Origin = "Color649Mod";

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-649-mod-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-649-game-").FullName;
    private readonly LoadOrderMirror _mirror;

    public LoadOrderMirror Mirror => _mirror;
    public string ModFolder => _modFolder;
    public PluginKey Plugin { get; } = new(PluginName, Origin);

    /// <summary>The alpha Light.Color is seeded with — deliberately neither 0 nor 255, so a test
    /// asserting it survived a 3-leaf edit cannot pass by coincidence against either default.</summary>
    public const byte SeededLightAlpha = 137;

    public FormKey Light { get; }
    public FormKey Keyword { get; }
    public FormKey LocationReferenceType { get; }
    public FormKey ActionRecord { get; }
    public FormKey Location { get; }
    public FormKey MaterialObject { get; }

    public ColorCompileFixture()
    {
        var pluginPath = Path.Combine(_modFolder, PluginName);
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

        mod.WriteToBinary(pluginPath);

        _mirror = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)_mirror).Reconcile(
            _gameDirectory, [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);
        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(_mirror.LoadOrder!, Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        _mirror.Dispose();
        TryDelete(_modFolder);
        TryDelete(_gameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }
}
