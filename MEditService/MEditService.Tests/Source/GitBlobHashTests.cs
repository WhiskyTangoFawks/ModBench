using System.Text;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using MEditService.Tests.RealData;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Source;

/// <summary>
/// <c>documents.content_hash</c> is <b>the git blob hash</b> of the document body —
/// not "a hash", and not a hash of our own devising. That is the whole point: the same bytes sitting
/// in a tracked mod folder's source have exactly this hash in git's object database, so a SQL
/// aggregate over content_hash and a <c>git cat-file</c> are talking about the same object.
///
/// Which makes real git the only honest oracle here. Asserting our SHA-1 against a SHA-1 we computed
/// the same way would be tautological — it would pass just as happily if we had the header format
/// wrong ("blob &lt;len&gt;\0", byte length not character length, no trailing anything). So every
/// test below shells out to the actual <c>git hash-object</c> and compares.
/// </summary>
public class GitBlobHashTests
{
    /// <summary>
    /// The oracle: real <c>git hash-object</c> over the same bytes. Run through
    /// <see cref="GitCli"/> (the assembly's one git execution boundary) against a scratch directory
    /// — <c>hash-object</c> needs no repository, and is verified here to ignore the junk GIT_DIR it
    /// is handed rather than being quietly influenced by one.
    /// </summary>
    private static string GitHashObject(byte[] content)
    {
        var dir = Directory.CreateTempSubdirectory("medit-blobhash-");
        try
        {
            var file = Path.Combine(dir.FullName, "content.bin");
            File.WriteAllBytes(file, content);
            return GitCli.Run(Path.Combine(dir.FullName, "no-such-gitdir"), dir.FullName, "hash-object", file).Trim();
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    /// <summary>
    /// The central case: a real record's real source text, straight out of
    /// the codec — the exact bytes ingest will store as the document body.
    /// </summary>
    [Fact]
    public async Task Of_ForARealRecordsSourceText_MatchesGitHashObject()
    {
        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath),
            GameRelease.Fallout4);
        var record = ((IFallout4ModGetter)overlay).Npcs.First();
        var body = await new RecordTextCodec(NullLogger<RecordTextCodec>.Instance)
            .SerializeToBytesAsync(record, GameRelease.Fallout4);

        Assert.NotEmpty(body);
        Assert.Equal(GitHashObject(body), GitBlobHash.Of(body));
    }

    /// <summary>
    /// Byte-exact, not text-exact. Multi-byte UTF-8 is the case that separates the two: a header
    /// built from <c>string.Length</c> rather than the byte count agrees with git for every
    /// ASCII-only body and disagrees the moment a record carries a non-ASCII EditorID or name — of
    /// which real game data has plenty.
    /// </summary>
    [Theory]
    [InlineData("")]
    [InlineData("{}\n")]
    [InlineData("{\n  \"EditorID\": \"Réservé\"\n}\n")]
    [InlineData("{\n  \"Name\": \"日本語テキスト\"\n}\n")]
    public void Of_ForBodiesGitCanAlsoHash_MatchesGitHashObject(string text)
    {
        var content = Encoding.UTF8.GetBytes(text);
        Assert.Equal(GitHashObject(content), GitBlobHash.Of(content));
    }

    /// <summary>
    /// Two different bodies must not collide, and — more usefully for the ITM/agreement aggregate
    /// that consumes this — two <i>equal</i> bodies must agree. COUNT(DISTINCT content_hash) = 1 is
    /// the whole read model of "every plugin says the same thing about this record".
    /// </summary>
    [Fact]
    public void Of_IsStableAcrossCallsAndDistinguishesDifferentBodies()
    {
        var a = Encoding.UTF8.GetBytes("{\n  \"Value\": 250\n}\n");
        var alsoA = Encoding.UTF8.GetBytes("{\n  \"Value\": 250\n}\n");
        var b = Encoding.UTF8.GetBytes("{\n  \"Value\": 251\n}\n");

        Assert.Equal(GitBlobHash.Of(a), GitBlobHash.Of(alsoA));
        Assert.NotEqual(GitBlobHash.Of(a), GitBlobHash.Of(b));
    }
}
