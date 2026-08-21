using System.Text;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Mutagen.Bethesda;

namespace MEditService.Tests.RealData;

/// <summary>
/// Unconditional coverage for the <c>Customizations/Omit</c> set adopted in #455
/// (<see cref="MEditService.Core.Serialization.SpriggitConditionOmitCustomization"/> and its two
/// siblings). <see cref="SpriggitParityGateTests"/> proves the same thing far more strongly, by
/// diffing against the real tool — but it is environment-gated and skips wherever the Spriggit
/// toolchain is absent, which is everywhere by default. These run always.
///
/// <para><b>Every assertion here is paired with a positive control.</b> "No <c>Unknown1</c> anywhere"
/// is trivially true of an empty tree, of a tree with no conditions in it, and of a tree that failed
/// to serialize — so each absence claim is stated alongside the count of documents that would have
/// carried the field. The committed fixture is chosen for exactly that reason: 3,940 authentic
/// records including four VMAD-scripted quests with 860 dialogue topics and 2,873 responses, which is
/// where FO4 conditions actually live.</para>
/// </summary>
public sealed class SpriggitOmitCustomizationsTests : IDisposable
{
    private const string Origin = "FixtureMod";

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-omit-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-omit-game-").FullName;

    public void Dispose()
    {
        TryDelete(_modFolder);
        TryDelete(_gameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* best-effort temp cleanup */ }
    }

    [Fact]
    public async Task TheTree_OmitsExactlyTheFieldsSpriggitsFallout4PackageOmits()
    {
        var documents = await SerializeFixtureThroughTheDoor();

        Assert.True(documents.Count > 3_000, $"only {documents.Count} documents serialized; expected a full tree.");

        // Positive control: the tree genuinely contains the structures these omissions apply to, so
        // the absence assertions below are claims about content rather than about emptiness. Before
        // the omission was adopted this same tree carried 1,929 Unknown1 occurrences across 981 files.
        var withConditions = documents.Count(pair => pair.Value.Contains("\"Conditions\"", StringComparison.Ordinal));
        Assert.True(withConditions > 100, $"only {withConditions} documents carry conditions; the Unknown1 claim would be vacuous.");

        Assert.Empty(DocumentsContaining(documents, "\"Unknown1\""));

        // The mod header's own source file is the root document, and it is the only place the two
        // header omissions can show up — asserted through the whole tree anyway rather than only
        // there, since a second header would be a defect in its own right.
        Assert.Empty(DocumentsContaining(documents, "\"NumRecords\""));
        Assert.Empty(DocumentsContaining(documents, "\"NextFormID\""));
        Assert.Empty(DocumentsContaining(documents, "\"OverriddenForms\""));

        // Positive control for the header pair: the root document exists, is the mod header's source
        // file, and still carries the header fields that are *not* omitted — so "no NumRecords" is not
        // passing because the header vanished (which is precisely how #454 found the header being
        // deleted from the baseline by a second, partial tree writer).
        var root = Assert.Single(documents, pair => pair.Key == "RecordData.json").Value;
        Assert.Contains("\"ModKey\": \"mEditTestSubset.esm\"", root, StringComparison.Ordinal);
        Assert.Contains("\"GameRelease\": \"Fallout4\"", root, StringComparison.Ordinal);
        Assert.Contains("\"MasterReferences\"", root, StringComparison.Ordinal);
    }

    private static string[] DocumentsContaining(Dictionary<string, string> documents, string needle) =>
        [.. documents
            .Where(pair => pair.Value.Contains(needle, StringComparison.Ordinal))
            .Select(pair => pair.Key)
            .Order(StringComparer.Ordinal)
            .Take(10)];

    private async Task<Dictionary<string, string>> SerializeFixtureThroughTheDoor()
    {
        var pluginPath = Path.Combine(_modFolder, CutDownPluginFixture.PluginFileName);
        File.Copy(CutDownPluginFixture.PluginPath, pluginPath);

        using var sessions = new SessionManager(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ISessionManager)sessions).LoadExplicit(
            _gameDirectory,
            [new ExplicitPluginInput(CutDownPluginFixture.PluginFileName, pluginPath, Origin, true)],
            GameRelease.Fallout4);

        var session = sessions.Session!;
        var mod = session.GetMod(CutDownPluginFixture.PluginFileName, Origin)!;
        var pristine = await TrackService.SerializeToPristineFiles(mod, CutDownPluginFixture.PluginFileName, session);

        var prefix = $"{CutDownPluginFixture.PluginFileName}{SourceRecordPath.SourceSuffix}{Path.DirectorySeparatorChar}";
        return pristine.ToDictionary(
            file => file.RelativePath[prefix.Length..].Replace(Path.DirectorySeparatorChar, '/'),
            file => Encoding.UTF8.GetString(file.Content),
            StringComparer.Ordinal);
    }
}
