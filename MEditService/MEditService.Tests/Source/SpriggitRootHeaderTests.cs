using MEditService.Core.Source;

namespace MEditService.Tests.Source;

/// <summary>
/// Whitespace-exact tests for the <c>SpriggitSource</c> splice into the root
/// <c>RecordData.json</c> (<see cref="SpriggitRootHeader.MergeSpriggitSource"/>).
///
/// <para>These are byte-for-byte assertions on purpose. The splice's whole reason for existing
/// (over parse-mutate-reserialize) is that it leaves every byte the kernel wrote untouched, so a
/// test that only checks the document still parses, or that the key is present, cannot see the
/// class of defect the splice is uniquely exposed to. #451's own test asserted exactly that much —
/// <c>SpriggitSource</c> is the first key, and the tree round-trips through the real deserializer —
/// and both passed while the splice was emitting <c>}},"ModKey"</c> with the separator before the
/// original first key eaten. Valid JSON, readable by real Spriggit, and not the bytes Spriggit
/// writes. Found by #455's parity gate against the real tool, which is the point of that gate.</para>
/// </summary>
public sealed class SpriggitRootHeaderTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("medit-root-header-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private string WriteRoot(string text)
    {
        var path = Path.Combine(_dir, SpriggitRootHeader.RecordDataFileName);
        File.WriteAllText(path, text);
        return path;
    }

    /// <summary>
    /// The defect #455 found on <c>main</c>: the whitespace between <c>{</c> and the original first
    /// key is consumed to learn the document's indent, used as the spliced object's <i>leading</i>
    /// separator, and then never re-emitted — so the original first key ends up welded to the
    /// spliced object's closing brace. Asserting the entire document rather than a substring is
    /// deliberate; a <c>Contains</c> check for the closing <c>},\n</c> would pass on the broken
    /// output too, since the spliced object's own inner braces supply one.
    /// </summary>
    [Fact]
    public void MergeSpriggitSource_ReEmitsTheSeparatorBeforeTheOriginalFirstKey()
    {
        var path = WriteRoot("{\n  \"ModKey\": \"Fixture.esp\",\n  \"GameRelease\": \"Fallout4\"\n}");

        SpriggitRootHeader.MergeSpriggitSource(path);

        Assert.Equal(
            "{\n"
            + "  \"SpriggitSource\": {\n"
            + $"    \"PackageName\": \"{SpriggitSource.CurrentPackageName}\",\n"
            + $"    \"Version\": \"{SpriggitSource.CurrentVersion}\"\n"
            + "  },\n"
            + "  \"ModKey\": \"Fixture.esp\",\n"
            + "  \"GameRelease\": \"Fallout4\"\n"
            + "}",
            File.ReadAllText(path));
    }

    /// <summary>
    /// The rival this class exists to kill: hardcoding <c>"\n  "</c> as the indent instead of reading
    /// the document's own. That passes the test above (the kernel's current indent happens to be two
    /// spaces) and silently mis-indents the moment the kernel's formatting changes — which is the
    /// exact drift the splice's doc comment claims to be immune to, since nothing pins Newtonsoft's
    /// indent width anywhere this code can cite.
    /// </summary>
    [Fact]
    public void MergeSpriggitSource_TakesItsIndentFromTheDocumentRatherThanAssumingTwoSpaces()
    {
        var path = WriteRoot("{\n    \"ModKey\": \"Fixture.esp\"\n}");

        SpriggitRootHeader.MergeSpriggitSource(path);

        Assert.Equal(
            "{\n"
            + "    \"SpriggitSource\": {\n"
            + $"        \"PackageName\": \"{SpriggitSource.CurrentPackageName}\",\n"
            + $"        \"Version\": \"{SpriggitSource.CurrentVersion}\"\n"
            + "    },\n"
            + "    \"ModKey\": \"Fixture.esp\"\n"
            + "}",
            File.ReadAllText(path));
    }
}
