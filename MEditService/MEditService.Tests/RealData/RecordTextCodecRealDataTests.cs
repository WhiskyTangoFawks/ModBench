using System.Diagnostics;
using MEditService.Core.Serialization;
using MEditService.Tests.TestSupport;
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
/// stays at 2, and the two serialized texts diverge starting inside the ObjectTemplates block. The
/// verbatim divergent snippet recorded in the #367 report is YAML text (this test predates #412's
/// swap to the JSON kernel) — the mechanism it demonstrates (a lazy-overlay read producing a
/// structurally different object graph than a deep parse, which this codec then faithfully
/// serializes either way) is format-independent and re-checked by this test's own assertions below
/// on every run; the literal snippet itself was never re-derived under JSON, since doing so would
/// require the same disallowed 0.54.0 dependency. See the #367 report for the original verbatim
/// failure output.
///
/// The round-trip fidelity assertion applies the same <c>GetEqualsMask</c> technique
/// <c>RecordTextCodecTests</c> uses on a synthetic weapon, but here against this real, dense fixture
/// record — a synthetic weapon alone leaves most fields at their CLR default on both sides of the
/// round trip, so a Mutagen bump that breaks e.g. <c>ObjectTemplates</c> or
/// <c>VirtualMachineAdapter</c> deserialization specifically would pass a synthetic-only check.
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
            using var overlayImport = ModFactory.ImportGetter(
                new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath),
                GameRelease.Fallout4);
            var deepParsedImport = ModFactory.ImportSetter(
                new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath),
                GameRelease.Fallout4);
            var overlay = (IFallout4ModGetter)overlayImport;
            var deepParsed = (IFallout4ModGetter)deepParsedImport;

            var overlayWeapon = overlay.Weapons.Single(w => w.EditorID == AffectedWeaponEditorId);
            var deepParsedWeapon = deepParsed.Weapons.Single(w => w.EditorID == AffectedWeaponEditorId);

            // The sanity condition, asserted rather than only logged: at the 0.53.1 pin both
            // readers agree (that IS the property this test protects), and the count is non-zero
            // (proving this weapon genuinely carries ObjectTemplates content — the shape #369's
            // pin comment says the 0.54.0 regression corrupts — rather than being an accidental
            // vacuous pass). A print here would be a sanity condition nobody is watching: a
            // fixture change that stopped exercising the regression shape would leave this test
            // green for the wrong reason.
            var overlayTemplateCount = overlayWeapon.ObjectTemplates?.Count ?? 0;
            var deepParsedTemplateCount = deepParsedWeapon.ObjectTemplates?.Count ?? 0;
            output.WriteLine($"Overlay ObjectTemplates: {overlayTemplateCount}, deep-parse ObjectTemplates: {deepParsedTemplateCount}");
            Assert.Equal(deepParsedTemplateCount, overlayTemplateCount);
            Assert.True(deepParsedTemplateCount > 0,
                "Expected this fixture weapon to carry ObjectTemplates content; pick a different affected weapon if it no longer does.");

            var overlayPath = Path.Combine(dir.FullName, "overlay.json");
            var deepParsedPath = Path.Combine(dir.FullName, "deep-parsed.json");

            var swSerializeOverlay = Stopwatch.StartNew();
            await codec.SerializeAsync(overlayWeapon, overlayPath, GameRelease.Fallout4);
            swSerializeOverlay.Stop();

            var swSerializeDeep = Stopwatch.StartNew();
            await codec.SerializeAsync(deepParsedWeapon, deepParsedPath, GameRelease.Fallout4);
            swSerializeDeep.Stop();

            var swDeserialize = Stopwatch.StartNew();
            var roundTripped = (Weapon)await codec.DeserializeAsync(deepParsedPath, GameRelease.Fallout4, "weap");
            swDeserialize.Stop();

            output.WriteLine($"AC4: serialize (overlay) {swSerializeOverlay.ElapsedMilliseconds} ms, " +
                $"serialize (deep parse) {swSerializeDeep.ElapsedMilliseconds} ms, " +
                $"deserialize {swDeserialize.ElapsedMilliseconds} ms " +
                "(spike #359 measured 129 ms serialize / 55 ms deserialize on a 20 MB plugin).");

            var overlayText = await File.ReadAllTextAsync(overlayPath);
            var deepParsedText = await File.ReadAllTextAsync(deepParsedPath);

            Assert.Equal(deepParsedText, overlayText);

            var mask = deepParsedWeapon.GetEqualsMask(roundTripped);
            var leaves = MaskInspector.CountLeaves(mask).ToList();
            var divergent = leaves.Where(l => !l.Value).Select(l => l.Path).ToList();

            Assert.NotEmpty(leaves);
            Assert.Empty(divergent);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }
}
