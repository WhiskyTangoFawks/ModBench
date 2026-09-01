using Mutagen.Bethesda.Binary;

namespace MEditService.Tests.Edits;

/// <summary>
/// #649: why all 11 float-encoded Color fields in Fallout 4 (8 <c>NoAlphaFloat</c> + 3
/// <c>AlphaFloat</c>) ship editable rather than declared read-only.
///
/// <para>Mutagen models every Color as a byte quadruple, but four of its binary encodings store
/// floats. Reading quantizes (<c>IBinaryStreamExt.GetColorByte</c>: <c>(byte)Math.Round(255 * f)</c>)
/// and writing dequantizes (<c>ColorBinaryTranslationExt.Write</c>: <c>(float)(component / 255d)</c>).
/// That pairing is lossy in exactly one direction, and which direction decides whether making these
/// fields editable is safe:</para>
///
/// <list type="bullet">
/// <item><b>arbitrary float -&gt; byte -&gt; float is lossy</b>, and essentially always
/// (<see cref="FloatToByteToFloat_LosesTheOriginalFloat_ForEssentiallyEveryValue"/>). This is real,
/// but it happens once, at Track, when Mutagen first reads the original binary — upstream of the
/// source document, and therefore upstream of anything an edit can reach.</item>
/// <item><b>byte -&gt; float -&gt; byte is exact</b>, for all 256 values
/// (<see cref="ByteToFloatToByte_IsExact_ForEveryByteValue"/>). This is the round trip an edit
/// actually performs: by the time this schema can write anything, the stored value is already a
/// byte (the source document holds a hex colour), so a component written through the editor reaches
/// the binary and returns from it unchanged.</item>
/// </list>
///
/// <para><b>The consequence for #649</b>: editability cannot fire the lossy direction, because the
/// lossy direction was never a function of editability. The fidelity loss on the first read of an
/// original binary is pre-existing, unowned, and untouched by this ticket — the compile path
/// (<c>PluginCompileService</c>, <c>PluginWriter</c>, <c>RecordTextCodec</c>) consults no reflected
/// schema at all, so no schema change can alter it in either direction. It is also structurally
/// invisible to <c>RealData.CompileRoundTripGateTests</c>, whose fidelity claim is source-text ->
/// binary -> source-text: the loss sits upstream of both ends of that comparison.</para>
///
/// <para>Both facts drive Mutagen's own helpers rather than a local restatement of the formulas —
/// a local copy would keep passing after an upstream change, which is the one failure this file
/// exists to prevent.</para>
/// </summary>
public class ColorQuantizationTests
{
    /// <summary>Mutagen's own write formula (ColorBinaryTranslation.cs:23-27 / :30-36).</summary>
    private static float Dequantize(byte component) => (float)(component / 255d);

    [Fact]
    public void ByteToFloatToByte_IsExact_ForEveryByteValue()
    {
        var drifted = new List<string>();
        for (int b = 0; b <= byte.MaxValue; b++)
        {
            var roundTripped = IBinaryStreamExt.GetColorByte(Dequantize((byte)b));
            if (roundTripped != b) drifted.Add($"{b} -> {roundTripped}");
        }

        Assert.True(drifted.Count == 0,
            "A colour component written through the editor must reach the binary and return from it " +
            $"unchanged, for every one of the 256 possible values. Drifted: {string.Join(", ", drifted)}. " +
            "If this ever fails, the 11 float-encoded Color fields must be declared read-only instead.");
    }

    [Fact]
    public void FloatToByteToFloat_LosesTheOriginalFloat_ForEssentiallyEveryValue()
    {
        // The counterpart, pinned so the asymmetry is documented by a test rather than by prose: the
        // direction that IS lossy, and which therefore must never be reachable from an edit. Fixed
        // seed — this characterises Mutagen's arithmetic, so it must not vary run to run.
        var random = new Random(649);
        var survived = new List<float>();
        for (int i = 0; i < 20_000; i++)
        {
            var original = (float)random.NextDouble();
            if (Dequantize(IBinaryStreamExt.GetColorByte(original)) == original) survived.Add(original);
        }

        // Not "zero survive" — n/255 values legitimately do. The claim is that survival is rare
        // enough that an arbitrary source float must be assumed lost, which is what makes the
        // quantization a real (pre-existing, unowned) fidelity loss rather than a theoretical one.
        Assert.True(survived.Count < 20,
            $"{survived.Count} of 20,000 arbitrary floats survived byte quantization. If this is now " +
            "high, Mutagen's Color encoding changed and #649's read-only reasoning needs revisiting.");
    }

    [Fact]
    public void GetColorByte_ClampsRatherThanWrapping_AtBothEnds()
    {
        // The two guards on the read side (IBinaryStreamExt.cs:81-88) — worth pinning because an
        // out-of-range float is exactly what a hand-edited or third-party plugin can carry, and
        // wrapping instead of clamping would turn a bright colour into a dark one silently.
        Assert.Equal(0, IBinaryStreamExt.GetColorByte(-1f));
        Assert.Equal(0, IBinaryStreamExt.GetColorByte(0f));
        Assert.Equal(byte.MaxValue, IBinaryStreamExt.GetColorByte(1000f));
    }
}
