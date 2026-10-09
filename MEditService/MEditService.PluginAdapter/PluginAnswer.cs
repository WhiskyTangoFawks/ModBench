using MEditService.Codec.Serialization;
using MEditService.RepositoriesLib;

namespace MEditService.PluginAdapter;

/// <summary>Builds the answers <see cref="Answer{T, TFailure}"/> carries.</summary>
public static class PluginAnswer
{
    public static Answer<T, PluginFailure> Of<T>(T value) => value;
}

/// <summary>Why a read or write of a plugin file stopped, in the words a refusal or a status names
/// it by.</summary>
public abstract record PluginFailure
{
    private PluginFailure(Exception? error) => Error = error;

    /// <summary>The throw that stopped the read or write, for the log.</summary>
    public Exception? Error { get; }

    public abstract string Reason { get; }

    /// <summary>The file system would not open the file: it is gone, another program holds it, or
    /// access is denied. Nothing is known of its bytes.</summary>
    public sealed record Inaccessible : PluginFailure
    {
        private readonly string _reason;

        internal Inaccessible(Exception error) : base(error) => _reason = error.Message;

        public override string Reason => _reason;
    }

    /// <summary>Mutagen could not read the bytes.</summary>
    public sealed record Unparsed : PluginFailure
    {
        internal Unparsed(PluginDiagnosis diagnosis, Exception error) : base(error) => Diagnosis = diagnosis;

        public PluginDiagnosis Diagnosis { get; }

        public override string Reason => Diagnosis.Describe();
    }

    /// <summary>The localization file a plugin declares and the disk has not.</summary>
    public sealed record MissingStrings : PluginFailure
    {
        internal MissingStrings(string file) : base(error: null) => File = file;

        public string File { get; }

        public override string Reason => $"its strings file '{File}' was not found";
    }

    /// <summary>ADR-0008's content-derived master pass pruned a master the write still needs: its only
    /// reference sits in a VMAD struct-list property, which Mutagen never walks (upstream issue 688).</summary>
    public sealed record PrunedMaster : PluginFailure
    {
        private readonly string _reason;

        internal PrunedMaster(Exception error) : base(error) => _reason = PluginDiagnosis.FromWriteException(error).Describe();

        public override string Reason => _reason;
    }

    /// <summary>The failure <paramref name="ex"/> stands for: a file system refusal is
    /// <see cref="Inaccessible"/>, anything else a read Mutagen could not make.</summary>
    internal static PluginFailure Of(Exception ex) =>
        Refusal(ex) is { } refusal
            ? new Inaccessible(refusal)
            : new Unparsed(PluginDiagnosis.FromParseException(ex), ex);

    // Mutagen wraps the file system's refusal in exceptions of its own.
    private static Exception? Refusal(Exception? ex) =>
        ex is null or IOException or UnauthorizedAccessException ? ex : Refusal(ex.InnerException);

    /// <summary>The failure a write's <paramref name="ex"/> stands for, or null for a throw that is a
    /// defect in the mod this adapter built, which propagates.</summary>
    internal static PluginFailure? OfWrite(Exception ex) => ex switch
    {
        IOException or UnauthorizedAccessException => new Inaccessible(ex),
        _ when PluginDiagnosis.HasUnmappableFormID(ex) => new PrunedMaster(ex),
        _ => null,
    };

    /// <summary>Whether <paramref name="ex"/> is the failure of the read or write it came out of:
    /// Mutagen fails in open-ended ways, and only running out of memory or being cancelled is not the
    /// file's answer.</summary>
    internal static bool StandsFor(Exception ex) => ex is not (OutOfMemoryException or OperationCanceledException);

    /// <summary><paramref name="read"/>'s value, or the failure its throw stands for.</summary>
    internal static Answer<T, PluginFailure> Answer<T>(Func<T> read)
    {
        try
        {
            return PluginAnswer.Of(read());
        }
        catch (Exception ex) when (StandsFor(ex))
        {
            return Of(ex);
        }
    }

    /// <summary><see cref="Answer{T}(Func{T})"/> for a read that awaits.</summary>
    internal static async Task<Answer<T, PluginFailure>> AnswerAsync<T>(Func<Task<T>> read)
    {
        try
        {
            return PluginAnswer.Of(await read());
        }
        catch (Exception ex) when (StandsFor(ex))
        {
            return Of(ex);
        }
    }
}
