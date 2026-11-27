namespace MEditService.TestSupport;

/// <summary>The kinds that wait for one platform, a release or the developer. A kind's name is its
/// trait value, which the test filters read.</summary>
public enum Kinds
{
    /// <summary>A tool, not a test (spec/architecture/tests.md). No gate runs it.</summary>
    Tool,

    /// <summary>The generator of a committed fixture. The developer runs it by name and approves what it writes.</summary>
    Generator,

    /// <summary>The test needs a POSIX file system: a file mode that makes a read, write or delete fail, a FIFO, or two
    /// names differing only in case.</summary>
    Posix,
}
