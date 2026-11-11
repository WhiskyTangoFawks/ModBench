using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Architecture.Tests;

public sealed class DocumentReadScanTests
{
    private const string BatchedRead = "MEditService.RecordIndex/CopyBodies.cs";

    private static readonly Regex StringLiteral = new(@"""""""[\s\S]*?""""""|""(?:[^""\\\r\n]|\\.)*""", RegexOptions.Compiled);
    private static readonly Regex Write = new(@"\b(?:INSERT|UPDATE)\b", RegexOptions.Compiled);
    private static readonly Regex SelectsBody = new(@"(?:\bSELECT\s+|,)\s*(?:\w+\.)?body\s*(?:,|\bFROM\b|\bAS\b|$)", RegexOptions.Compiled);

    [Fact]
    public void NothingButTheBatchedRead_SelectsADocument()
    {
        var root = ServiceProjects.SolutionDirectory();
        var walked = ServiceProjects.ProductionFiles(root);

        AssertOnlyTheBatchedReadSelects(root, walked);
        Assert.True(
            Selecting(root, walked).Contains(BatchedRead),
            $"{BatchedRead} selects no document — delete the exemption rather than leaving it pre-authorized.");
    }

    [Fact]
    public void TheScan_PassesTheBatchedReadAWriteAndAFunctionOfBody_AndNamesAQuerySelectingBodyElsewhere()
    {
        using var root = new ScratchDirectory("medit-document-read-scan-");
        ScratchFiles.Plant(root, BatchedRead, "context.Rows($\"\"\"\n    SELECT form_key, body FROM records\n    \"\"\", map);\n");
        ScratchFiles.Plant(root, "MEditService.RecordIndex/Write.cs", "Execute(\"INSERT INTO records SELECT form_key, body FROM staged\");\n");
        ScratchFiles.Plant(root, "MEditService.RecordIndex/Length.cs", "Rows(\"SELECT form_key, strlen(body) FROM records\");\n");
        ScratchFiles.Plant(root, "MEditService.RecordIndex/Arguments.cs", "Document(editorId, body, schema);\n");
        ScratchFiles.Plant(root, "MEditService.RecordIndex/Raw.cs", "Rows($\"\"\"\n    SELECT r.form_key, r.body\n    FROM records r\n    \"\"\");\n");
        ScratchFiles.Plant(root, "MEditService.RecordIndex/Plain.cs", "Rows(\"SELECT body FROM records WHERE form_key = $1\");\n");
        var files = SourceTree.CSharpFiles(root).ToList();

        Assert.Equal(
            ["MEditService.RecordIndex/Plain.cs", "MEditService.RecordIndex/Raw.cs"],
            SelectingOutsideTheBatchedRead(root, files));
        var failure = Assert.Throws<Xunit.Sdk.TrueException>(() => AssertOnlyTheBatchedReadSelects(root, files));
        Assert.Contains("MEditService.RecordIndex/Raw.cs", failure.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("SELECT * FROM records")]
    [InlineData("SELECT r.* FROM records r")]
    [InlineData("SELECT DISTINCT body FROM records")]
    [InlineData("SELECT body::VARCHAR FROM records")]
    [InlineData("SELECT lower(body) FROM records")]
    [InlineData("UPDATE records SET editor_id = NULL RETURNING form_key, body")]
    public void TheScan_IsBlindTo_ADocumentSelectedThisWay(string sql)
    {
        using var root = new ScratchDirectory("medit-document-read-scan-limits-");
        ScratchFiles.Plant(root, "MEditService.RecordIndex/Unseen.cs", $"Rows(\"{sql}\");\n");

        Assert.Empty(SelectingOutsideTheBatchedRead(root, SourceTree.CSharpFiles(root).ToList()));
    }

    private static void AssertOnlyTheBatchedReadSelects(string root, IReadOnlyList<string> files)
    {
        var elsewhere = SelectingOutsideTheBatchedRead(root, files);
        Assert.True(
            elsewhere.Count == 0,
            $"A production file outside {BatchedRead} selects body. Read documents through CopyBodies, a batch of one "
            + "for one record: a query reading many records' documents at once holds them all in memory (ADR-0010):\n"
            + string.Join("\n", elsewhere));
    }

    private static List<string> SelectingOutsideTheBatchedRead(string root, IEnumerable<string> files) =>
        [.. Selecting(root, files).Where(file => file != BatchedRead)];

    private static List<string> Selecting(string root, IEnumerable<string> files) =>
        [.. files
            .Where(file => StringLiteral.Matches(File.ReadAllText(file))
                .Any(literal => !Write.IsMatch(literal.Value) && SelectsBody.IsMatch(literal.Value.Trim('"'))))
            .Select(file => SourceTree.Relative(root, file))
            .Order(StringComparer.Ordinal)];
}
