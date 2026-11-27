namespace MEditService.TestSupport;

/// <summary>The kinds that wait for one platform or a release. A kind's name is its
/// trait value, which the test filters read.</summary>
public enum Kinds
{
    /// <summary>A tool, not a test (spec/architecture/tests.md), or the generator of a committed fixture. No gate runs it.</summary>
    Tool,

    /// <summary>The test needs a POSIX file system: a file mode that makes a read, write or delete fail, a FIFO, or two
    /// names differing only in case.</summary>
    Posix,
}
