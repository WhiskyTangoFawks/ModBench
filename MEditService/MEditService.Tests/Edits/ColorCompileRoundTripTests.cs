using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>
/// #649 AC #3/#4: a Color edit made through <see cref="RecordEditService.EditField"/> survives the
/// full source-text -> binary compile and reparses to the value that was written.
///
/// <para>"Round trip" here means what <see cref="AbstractUnionCompileRoundTripTests"/> means by it,
/// and for the same #360 reason: the assertion is against the record reparsed out of the compiled
/// binary through Mutagen's own reader, never against the source document. A document-substring
/// check would prove only the layer that already worked — Color has always been safe in the
/// document (it serializes as a hex string via Noggog's <c>ColorExt.ToHexString</c>); what was blind
/// was the editor surface, and the editor surface is what reaches the binary.</para>
///
/// <para><b>These facts are green on arrival</b>, because slice 1 built the write path at the same
/// time as the read path — the atomic-value class emits its Extract and Apply as a pair, which is
/// commitment 3's whole point. They are therefore paired with rivals rather than with a red run;
/// each rival is named on the fact it guards.</para>
/// </summary>
public sealed class ColorCompileRoundTripTests : IDisposable
{
    private readonly ColorCompileFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private RecordEditService EditService() =>
        new(_fixture.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private IFallout4ModGetter CompileAndReparse()
    {
        var result = new PluginCompileService(
                _fixture.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance),
                NullLogger<PluginCompileService>.Instance)
            .Compile(_fixture.Plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(_fixture.ModFolder, ColorCompileFixture.PluginName);
        return (IFallout4ModGetter)ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(ColorCompileFixture.PluginName), pluginPath), GameRelease.Fallout4);
    }

    private void Edit(FormKey record, string field, string json)
    {
        var result = EditService().EditField(_fixture.Plugin, record.ToString(), field, Json(json));
        Assert.True(result.Applied, result.Message);
    }

    // ── AC #4: a second common Color carrier, on the 3-leaf (wbByteColors) shape ───────────────

    /// <summary>
    /// Rival: null the atomic-value <c>Apply</c> in <c>BuildAtomicValueColumn</c>. Observed —
    /// <c>EditField</c> refuses <c>FieldReadOnly</c> ("'color' is read-only.") and this fails at the
    /// <c>Assert.True(result.Applied)</c> inside <see cref="Edit"/>, before any compile happens.
    /// </summary>
    [Fact]
    public void Light_ColorEdit_CompilesAndReparsesTheNewRgb()
    {
        Edit(_fixture.Light, "color", """{"red": 200, "green": 100, "blue": 50}""");

        var light = CompileAndReparse().Lights.Single(l => l.FormKey == _fixture.Light);
        Assert.Equal(200, light.Color.R);
        Assert.Equal(100, light.Color.G);
        Assert.Equal(50, light.Color.B);
    }

    /// <summary>
    /// The other half of the 3-leaf contract, and the one a careless recompose would break: Light is
    /// <c>ColorBinaryType.Alpha</c>, so its fourth byte is really on disk even though xEdit declines
    /// to render it. An edit naming only red/green/blue must leave that byte exactly as it was —
    /// not zero it, not default it to 255.
    ///
    /// <para>Rival: recompose from a fresh box rather than the current value (i.e.
    /// <c>StageAtomicValue</c> ignoring its argument). Observed — this fails with
    /// <c>Assert.Equal() Failure: Values differ / Expected: 137 / Actual: 0</c>, while
    /// <see cref="Light_ColorEdit_CompilesAndReparsesTheNewRgb"/> above still passes. That pairing is
    /// the point: without this fact the rival ships silently.</para>
    /// </summary>
    [Fact]
    public void Light_ColorEdit_NamingOnlyRgb_PreservesTheExistingAlphaByte()
    {
        Edit(_fixture.Light, "color", """{"red": 200, "green": 100, "blue": 50}""");

        var light = CompileAndReparse().Lights.Single(l => l.FormKey == _fixture.Light);
        Assert.Equal(ColorCompileFixture.SeededLightAlpha, light.Color.A);
    }

    // ── Coordinator's addition: one compile proof per allowlist row ────────────────────────────

    /// <summary>
    /// Every row of <c>SchemaReflector.AlphaBearingColorFields</c> gets its own compile proof that an
    /// alpha edit actually reaches the binary — the empirical half of the alpha loop, since nothing
    /// in metadata can assert "this field's alpha is meaningful" (the binary type is not
    /// reflectable). Four rows, four records, no representative standing in for the others.
    ///
    /// <para>Rival: drop any row from the allowlist. Observed for <c>IKeywordGetter</c> — the payload
    /// names <c>alpha</c>, which is then not a sub-field of the 3-leaf shape, so the write is refused
    /// and the <c>kywd</c> case fails at <see cref="Edit"/>'s <c>Assert.True(result.Applied)</c>.</para>
    /// </summary>
    [Theory]
    [InlineData("kywd")]
    [InlineData("lcrt")]
    [InlineData("aact")]
    [InlineData("lctn")]
    public void AllowlistedColorField_AlphaEdit_CompilesAndReparsesAllFourComponents(string table)
    {
        var record = table switch
        {
            "kywd" => _fixture.Keyword,
            "lcrt" => _fixture.LocationReferenceType,
            "aact" => _fixture.ActionRecord,
            "lctn" => _fixture.Location,
            _ => throw new ArgumentOutOfRangeException(nameof(table), table, "unknown allowlist table"),
        };

        Edit(record, "color", """{"red": 40, "green": 80, "blue": 120, "alpha": 160}""");

        var mod = CompileAndReparse();
        var actual = table switch
        {
            "kywd" => mod.Keywords.Single(r => r.FormKey == record).Color,
            "lcrt" => mod.LocationReferenceTypes.Single(r => r.FormKey == record).Color,
            "aact" => mod.Actions.Single(r => r.FormKey == record).Color,
            "lctn" => mod.Locations.Single(r => r.FormKey == record).Color,
            _ => null,
        };

        Assert.NotNull(actual);
        Assert.Equal((40, 80, 120, 160), (actual.Value.R, actual.Value.G, actual.Value.B, actual.Value.A));
    }

    // ── The float-encoded storage, against a real compile ──────────────────────────────────────

    /// <summary>
    /// <c>MaterialObject.SinglePassColor</c> is <c>ColorBinaryType.NoAlphaFloat</c>: the compiled
    /// binary stores three floats, each written as <c>(float)(byte / 255d)</c> and read back as
    /// <c>(byte)Math.Round(255 * f)</c>. <see cref="ColorQuantizationTests"/> proves that round trip
    /// exact for all 256 byte values in the abstract; this is the same claim through the real
    /// compile, so the two cannot drift apart.
    ///
    /// <para>This is why all 11 float-encoded Color fields ship editable rather than declared
    /// read-only: the lossy direction of Mutagen's Color model is <i>arbitrary float -&gt; byte</i>,
    /// which happens once at Track, upstream of anything an edit can reach. By the time this write
    /// path exists the stored value is already a byte, and byte -&gt; float -&gt; byte is lossless.</para>
    /// </summary>
    [Fact]
    public void FloatEncodedColor_Edit_CompilesAndReparsesTheExactBytes()
    {
        Edit(_fixture.MaterialObject, "single_pass_color", """{"red": 1, "green": 254, "blue": 127}""");

        var materialObject = CompileAndReparse().MaterialObjects.Single(m => m.FormKey == _fixture.MaterialObject);
        Assert.Equal(1, materialObject.SinglePassColor.R);
        Assert.Equal(254, materialObject.SinglePassColor.G);
        Assert.Equal(127, materialObject.SinglePassColor.B);
    }
}
