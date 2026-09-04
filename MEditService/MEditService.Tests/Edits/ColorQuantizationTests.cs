using Mutagen.Bethesda.Binary;

namespace MEditService.Tests.Edits;

/// <summary>Byte to float to byte is exact for all 256 values, and that is the round trip an
/// edit performs; the lossy direction happens once at Track, upstream of any edit.</summary>
public class ColorQuantizationTests
{
    // A hand-copy of Mutagen's own write formula, the pin that lets an upstream change be noticed.
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
        // The direction that is lossy, and which therefore must never be reachable from an edit. Fixed
        // seed: this characterises Mutagen's arithmetic, so it must not vary run to run.
        var random = new Random(649);
        var survived = new List<float>();
        for (int i = 0; i < 20_000; i++)
        {
            var original = (float)random.NextDouble();
            if (Dequantize(IBinaryStreamExt.GetColorByte(original)) == original) survived.Add(original);
        }

        // Not "zero survive" — n/255 values legitimately do. Survival is rare enough that an arbitrary
        // source float must be assumed lost, which makes the quantization a real fidelity loss.
        Assert.True(survived.Count < 20,
            $"{survived.Count} of 20,000 arbitrary floats survived byte quantization. If this is now " +
            "high, Mutagen's Color encoding changed and #649's read-only reasoning needs revisiting.");
    }

    [Fact]
    public void GetColorByte_ClampsRatherThanWrapping_AtBothEnds()
    {
        // The two guards on the read side (IBinaryStreamExt.cs:81-88): an out-of-range float is what
        // a hand-edited plugin can carry, and wrapping instead of clamping turns a bright colour
        // dark.
        Assert.Equal(0, IBinaryStreamExt.GetColorByte(-1f));
        Assert.Equal(0, IBinaryStreamExt.GetColorByte(0f));
        Assert.Equal(byte.MaxValue, IBinaryStreamExt.GetColorByte(1000f));
    }
}
