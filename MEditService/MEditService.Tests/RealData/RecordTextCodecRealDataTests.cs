using System.Diagnostics;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Xunit.Abstractions;

namespace MEditService.Tests.RealData;

/// <summary>
/// #367, condition 2 (reader-agnosticism) and AC4 (measured cost), run together against real data
/// so both use the exact production reader shapes.
///
/// <see cref="RecordTextCodec"/> is reader-agnostic by signature (<c>IWeaponGetter</c> is satisfied
/// by both the overlay and the deep parse) but not by construction — it faithfully serializes
/// whatever object graph it is handed, including any reader-specific defect in that graph. This
/// test proves the two production readers agree on a real weapon <b>today</b>, at the 0.53.1 pin,
/// rather than assuming it — the same shape as #369's
/// <see cref="BinaryRoundTripGateTests.LazyOverlayReloadAndRewrite_ProducesByteIdenticalOutput"/>
/// gate, which pins the write side of the same defect. The record chosen
/// (<c>VRWorkshopShared_AlienBlaster_NonPlayable</c>, FormID 24A3B0) is one of the four weapons in
/// <see cref="CutDownPluginFixture"/> confirmed carrying the ObjectTemplate shape the 0.54.0 overlay
/// regression corrupts (#369's pin comment); an unaffected weapon would prove nothing here. Verified
/// manually (not asserted — asserting it would require taking the 0.54.0 dependency this repo
/// cannot take) that flipping the Mutagen.Bethesda.Fallout4 pin to 0.54.0 makes this test fail: the
/// overlay-read weapon's ObjectTemplates split from 2 to 3 entries while the deep-parsed weapon
/// stays at 2, and the two serialized YAML texts diverge starting inside the ObjectTemplates block
/// (first divergent text: expected "...FirstPersonModel:\n  F..." vs actual "...- Name:\n    TargetLan...").
/// See the #367 report for the full verbatim failure output.
/// </summary>
public class RecordTextCodecRealDataTests(ITestOutputHelper output)
{
    private const string AffectedWeaponEditorId = "VRWorkshopShared_AlienBlaster_NonPlayable";

    [Fact]
    public async Task OverlayAndDeepParse_SerializeToIdenticalText()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var dir = Directory.CreateTempSubdirectory("medit-codec-realdata-");
        try
        {
            using var overlayDisposable = ModFactory.ImportGetter(
                new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath),
                GameRelease.Fallout4);
            var deepParsedDisposable = ModFactory.ImportSetter(
                new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath),
                GameRelease.Fallout4);
            var overlay = (IFallout4ModGetter)overlayDisposable;
            var deepParsed = (IFallout4ModGetter)deepParsedDisposable;

            var overlayWeapon = overlay.Weapons.Single(w => w.EditorID == AffectedWeaponEditorId);
            var deepParsedWeapon = deepParsed.Weapons.Single(w => w.EditorID == AffectedWeaponEditorId);

            // Sanity: this is the shape #369 pins — if these ever match, the fixture no longer
            // exercises the regression and this test should pick a different record.
            output.WriteLine($"Overlay ObjectTemplates: {overlayWeapon.ObjectTemplates?.Count ?? 0}, " +
                $"deep-parse ObjectTemplates: {deepParsedWeapon.ObjectTemplates?.Count ?? 0}");

            var overlayPath = Path.Combine(dir.FullName, "overlay.yaml");
            var deepParsedPath = Path.Combine(dir.FullName, "deep-parsed.yaml");

            var swSerializeOverlay = Stopwatch.StartNew();
            await codec.SerializeAsync(overlayWeapon, overlayPath);
            swSerializeOverlay.Stop();

            var swSerializeDeep = Stopwatch.StartNew();
            await codec.SerializeAsync(deepParsedWeapon, deepParsedPath);
            swSerializeDeep.Stop();

            var swDeserialize = Stopwatch.StartNew();
            var roundTripped = await codec.DeserializeAsync(deepParsedPath);
            swDeserialize.Stop();

            output.WriteLine($"AC4: serialize (overlay) {swSerializeOverlay.ElapsedMilliseconds} ms, " +
                $"serialize (deep parse) {swSerializeDeep.ElapsedMilliseconds} ms, " +
                $"deserialize {swDeserialize.ElapsedMilliseconds} ms " +
                "(spike #359 measured 129 ms serialize / 55 ms deserialize on a 20 MB plugin).");

            var overlayText = await File.ReadAllTextAsync(overlayPath);
            var deepParsedText = await File.ReadAllTextAsync(deepParsedPath);

            Assert.Equal(deepParsedText, overlayText);
            Assert.Equal(deepParsedWeapon.EditorID, roundTripped.EditorID);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }
}
