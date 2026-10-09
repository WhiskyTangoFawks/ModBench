namespace MEditService.TestSupport;

public static class OneInsertion
{
    /// <summary>Every byte of <paramref name="original"/> sits in <paramref name="edited"/> as it was, on one side or
    /// the other of a single inserted run.</summary>
    public static void AssertKeepsEveryOtherByte(string original, string edited)
    {
        var prefix = 0;
        while (prefix < original.Length && prefix < edited.Length && original[prefix] == edited[prefix]) prefix++;
        var suffix = 0;
        while (suffix < original.Length - prefix && suffix < edited.Length - prefix
               && original[^(suffix + 1)] == edited[^(suffix + 1)]) suffix++;
        Assert.True(prefix + suffix == original.Length, $"Changed beyond an insertion at {prefix}:\n{edited}");
    }
}
