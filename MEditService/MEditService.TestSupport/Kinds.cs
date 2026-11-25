namespace MEditService.TestSupport;

/// <summary>The kinds that wait for a merge to main, or for a real machine, or for one platform.</summary>
public static class Kinds
{
    /// <summary>The input is a modlist of real size, which takes minutes to index.</summary>
    public const string RealSize = "RealSize";

    /// <summary>The input is the user's game folder.</summary>
    public const string Smoke = "Smoke";

    /// <summary>The test needs a POSIX file system: a file mode that makes a read, write or delete fail, a FIFO, or two
    /// names differing only in case.</summary>
    public const string Posix = "Posix";

    /// <summary>The result is a measured time or memory against a limit, and a virtual machine's speed and memory move it.</summary>
    public const string Measured = "Measured";
}
