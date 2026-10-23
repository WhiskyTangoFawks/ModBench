using System.Reflection;
using System.Runtime.ExceptionServices;
using MEditService.Codec.Serialization;
using MEditService.PluginAdapter.Repair;
using MEditService.RepositoriesLib;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Exceptions;

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

    /// <summary>Whether the failure is the plugin's own bytes' answer, which holds until they change.</summary>
    public virtual bool OfItsBytes => true;

    /// <summary>The file system would not open the file: it is gone, another program holds it, or
    /// access is denied. Nothing is known of its bytes.</summary>
    public sealed record Inaccessible : PluginFailure
    {
        private readonly string _reason;

        internal Inaccessible(Exception error) : base(error) => _reason = error.Message;

        public override string Reason => _reason;

        public override bool OfItsBytes => false;
    }

    /// <summary>Mutagen could not read the bytes.</summary>
    public sealed record Unparsed : PluginFailure
    {
        internal Unparsed(PluginDiagnosis diagnosis, Exception error) : base(error) => Diagnosis = diagnosis;

        public PluginDiagnosis Diagnosis { get; }

        /// <summary>What the malformation scan found in the record Mutagen failed at, or why the scan could not
        /// run; null when it was not asked.</summary>
        public Answer<IReadOnlyList<RepairPreview>, PluginFailure>? Malformations { get; private init; }

        internal Unparsed ScannedFor(Func<PluginDiagnosis, IReadOnlyList<RepairPreview>> scan) =>
            this with { Malformations = Answer(() => scan(Diagnosis)) };

        public override string Reason => Diagnosis.Describe();
    }

    /// <summary>The localization file a plugin declares and the disk has not.</summary>
    public sealed record MissingStrings : PluginFailure
    {
        internal MissingStrings(string file) : base(error: null) => File = file;

        public string File { get; }

        public override string Reason => $"its strings file '{File}' was not found";

        public override bool OfItsBytes => false;
    }

    /// <summary>An archive the plugin's strings are looked up in that could not be read.</summary>
    internal sealed record UnreadableStrings : PluginFailure
    {
        private readonly string _reason;

        internal UnreadableStrings(string archive, Exception error) : base(error) =>
            _reason = $"its strings archive '{archive}' could not be read: {error.Message}";

        public override string Reason => _reason;

        public override bool OfItsBytes => false;
    }

    /// <summary>ADR-0008's content-derived master pass pruned a master the write still needs, through a
    /// FormLink Mutagen's link enumeration does not yield.</summary>
    public sealed record PrunedMaster : PluginFailure
    {
        private readonly string _reason;

        internal PrunedMaster(Exception error) : base(error) => _reason = PluginDiagnosis.FromWriteException(error).Describe();

        public override string Reason => _reason;
    }

    /// <summary>A record of the plugin's own object ID 0, whose FormKey is the one the plugin header's
    /// source document holds.</summary>
    public sealed record HeaderFormKeyHeld : PluginFailure
    {
        private readonly string _reason;

        internal HeaderFormKeyHeld(string signature, FormKey formKey) : base(error: null) =>
            _reason = $"{signature} {formKey} holds object ID 000000, the FormKey its plugin header's source holds";

        public override string Reason => _reason;
    }

    /// <summary>A record of FormID 00000000, which a full import reads as the null FormKey.</summary>
    public sealed record NullFormIdHeld : PluginFailure
    {
        private readonly string _reason;

        internal NullFormIdHeld(string signature) : base(error: null) =>
            _reason = $"{signature} 00000000 holds the null FormID, so the plugin is malformed";

        public override string Reason => _reason;
    }

    /// <summary>The plugin read or written references a plugin the load order does not hold.</summary>
    public sealed record MasterNotInLoadOrder : PluginFailure
    {
        private readonly string _reason;

        internal MasterNotInLoadOrder(MissingModException error) : base(error) =>
            _reason = $"it references {string.Join(", ", error.ModPaths.Select(path => path.ModKey.FileName))}, which the load order does not hold";

        public override string Reason => _reason;

        public override bool OfItsBytes => false;
    }

    /// <summary>A master the plugin read or written references whose header does not read, so its style,
    /// which the read or write needs, is unknown.</summary>
    public sealed record MasterUnreadable : PluginFailure
    {
        private readonly string _reason;

        internal MasterUnreadable(ModKey master, PluginFailure unread) : base(unread.Error)
        {
            Master = master.FileName;
            _reason = $"its master {Master} could not be read: {unread.Reason}";
        }

        public string Master { get; }

        public override string Reason => _reason;

        public override bool OfItsBytes => false;
    }

    /// <summary>The plugin's bytes are not the ones its repair preview read (ADR-0003).</summary>
    public sealed record ChangedSincePreview : PluginFailure
    {
        internal ChangedSincePreview() : base(error: null)
        {
        }

        public override string Reason => "its bytes changed since the repair preview";

        public override bool OfItsBytes => false;
    }

    /// <summary>A diagnosis chosen for repair that no repair answers.</summary>
    public sealed record NoRepair : PluginFailure
    {
        private readonly string _reason;

        internal NoRepair(PluginDiagnosis diagnosis) : base(error: null) => _reason = $"no repair answers {diagnosis.Describe()}";

        public override string Reason => _reason;
    }

    /// <summary>A repaired plugin whose records are not its original's with the repairs its preview planned.</summary>
    public sealed record RepairUnverified : PluginFailure
    {
        private readonly string _reason;

        internal RepairUnverified(string reason) : base(error: null) => _reason = reason;

        public override string Reason => _reason;
    }

    /// <summary>The failure <paramref name="ex"/> stands for: a file system refusal is
    /// <see cref="Inaccessible"/>, anything else a read Mutagen could not make. Mutagen reaches some
    /// readers by reflection, whose wrapper says nothing of the read.</summary>
    internal static PluginFailure Of(Exception ex) => ex switch
    {
        TargetInvocationException { InnerException: { } invoked } => Of(invoked),
        MissingModException missing => new MasterNotInLoadOrder(missing),
        PluginFailureException { Failure: { } failure } => failure,
        _ when Refusal(ex) is { } refusal => new Inaccessible(refusal),
        _ => new Unparsed(PluginDiagnosis.FromParseException(ex), ex),
    };

    // Mutagen wraps the file system's refusal in exceptions of its own.
    private static Exception? Refusal(Exception? ex) =>
        ex is null or IOException or UnauthorizedAccessException ? ex : Refusal(ex.InnerException);

    /// <summary>The failure a write's <paramref name="ex"/> stands for, or null for a throw that is a
    /// defect in the mod this adapter built, which propagates.</summary>
    internal static PluginFailure? OfWrite(Exception ex) => ex switch
    {
        IOException or UnauthorizedAccessException => new Inaccessible(ex),
        _ when PluginDiagnosis.HasUnmappableFormID(ex) => new PrunedMaster(ex),
        MissingModException missing => new MasterNotInLoadOrder(missing),
        _ => null,
    };

    /// <summary>Throws the out-of-memory or cancellation inside <paramref name="ex"/> as itself, so a
    /// caller's own check sees it, unless <paramref name="file"/> declares a length that ran it out.</summary>
    internal static void ThrowIfNotTheFilesAnswer(Exception ex, PluginRecordBytes? file = null)
    {
        if (OutOfMemoryOrCancellation.In(ex) is { } cause
            && !(cause is OutOfMemoryException && file is { DeclaresALengthItCannotInflateTo: true }))
            ExceptionDispatchInfo.Throw(cause);
    }

    /// <summary><paramref name="read"/>'s value, or the failure its throw stands for.</summary>
    internal static Answer<T, PluginFailure> Answer<T>(Func<T> read, PluginRecordBytes? file = null)
    {
        try
        {
            return PluginAnswer.Of(read());
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            ThrowIfNotTheFilesAnswer(ex, file);
            return Of(ex);
        }
    }

    /// <summary><see cref="Answer{T}(Func{T}, PluginRecordBytes)"/> for a read that awaits.</summary>
    internal static async Task<Answer<T, PluginFailure>> AnswerAsync<T>(Func<Task<T>> read)
    {
        try
        {
            return PluginAnswer.Of(await read());
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            ThrowIfNotTheFilesAnswer(ex);
            return Of(ex);
        }
    }
}

/// <summary>Carries out through Mutagen's read the failure of a file the read needs besides the plugin,
/// which names that file.</summary>
internal sealed class PluginFailureException : InvalidOperationException
{
    // RCS1194's standard constructors; a read throws only with a failure.
    internal PluginFailureException()
    {
    }

    internal PluginFailureException(string message) : base(message)
    {
    }

    internal PluginFailureException(string message, Exception innerException) : base(message, innerException)
    {
    }

    internal PluginFailureException(PluginFailure failure) : base(failure.Reason, failure.Error) => Failure = failure;

    internal PluginFailure? Failure { get; }
}
