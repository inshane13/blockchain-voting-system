// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IVoterRegistry} from "./IVoterRegistry.sol";

/// @title Blockchain Voting System with Commit-Reveal Logic
/// @notice Implements anti-griefing scoped commitments and timing edge fixes.
///         Two-phase scheme: voters commit a hash of (candidateIndex, salt),
///         then reveal the plaintext after the commit deadline.
/// @dev Single-election only. Winner is computed via getWinner() after reveal.
contract Voting {
    error InvalidRegistry();
    error NoCandidates();
    error InvalidDurations();
    error CommitPhaseOver();
    error CommitPhaseActive();
    error AlreadyVoted();
    error AlreadyCommitted();
    error NotEligible();
    error InvalidHash();
    error RevealPhaseOver();
    error InvalidCandidate();
    error HashMismatch();

    struct Election {
        string name;
        string[] candidates;
        mapping(uint256 => uint256) votes;
        mapping(address => bytes32) commits;
        mapping(address => bool) hasVoted;
        mapping(address => bool) hasCommitted;
        uint256 commitDeadline;
        uint256 revealDeadline;
    }

    Election public election;
    IVoterRegistry public immutable VOTER_REGISTRY;

    event VoteCommitted(address indexed voter, bytes32 hash);
    event VoteRevealed(address indexed voter, uint256 indexed candidateIndex);

    constructor(
        string memory _name,
        string[] memory _candidates,
        uint256 _commitTime,
        uint256 _revealTime,
        address _voterRegistry
    ) {
        if (_voterRegistry == address(0)) revert InvalidRegistry();
        if (_candidates.length == 0) revert NoCandidates();
        if (_commitTime == 0 || _revealTime == 0) revert InvalidDurations();
        VOTER_REGISTRY = IVoterRegistry(_voterRegistry);
        election.name = _name;
        election.candidates = _candidates;
        election.commitDeadline = block.timestamp + _commitTime;
        election.revealDeadline = election.commitDeadline + _revealTime;
    }

    /// @notice Submit a hashed commitment during the commit phase.
    /// @param hash keccak256(abi.encode(candidateIndex, salt))
    function commit(bytes32 hash) external {
        if (block.timestamp >= election.commitDeadline) revert CommitPhaseOver();
        if (election.hasVoted[msg.sender]) revert AlreadyVoted();
        if (election.hasCommitted[msg.sender]) revert AlreadyCommitted();
        if (!VOTER_REGISTRY.isEligible(msg.sender)) revert NotEligible();
        if (hash == bytes32(0)) revert InvalidHash();

        election.commits[msg.sender] = hash;
        election.hasCommitted[msg.sender] = true;
        emit VoteCommitted(msg.sender, hash);
    }

    /// @notice Reveal the vote choice and salt during the reveal phase.
    /// @param idx Index of the chosen candidate.
    /// @param salt keccak256 hash of the user's raw secret string.
    function reveal(uint256 idx, bytes32 salt) external {
        if (block.timestamp < election.commitDeadline) revert CommitPhaseActive();
        if (block.timestamp >= election.revealDeadline) revert RevealPhaseOver();
        if (election.hasVoted[msg.sender]) revert AlreadyVoted();
        if (idx >= election.candidates.length) revert InvalidCandidate();

        bytes32 expected = keccak256(abi.encode(idx, salt));
        if (election.commits[msg.sender] != expected) revert HashMismatch();

        election.votes[idx]++;
        election.hasVoted[msg.sender] = true;
        delete election.commits[msg.sender];
        emit VoteRevealed(msg.sender, idx);
    }

    /// @notice Returns vote count for a candidate index.
    function getVotes(uint256 index) external view returns (uint256) {
        return election.votes[index];
    }

    /// @notice Returns the candidate list.
    function getCandidates() external view returns (string[] memory) {
        return election.candidates;
    }

    /// @notice Returns the election name.
    function getName() external view returns (string memory) {
        return election.name;
    }

    function getCommitDeadline() external view returns (uint256) {
        return election.commitDeadline;
    }

    function getRevealDeadline() external view returns (uint256) {
        return election.revealDeadline;
    }

    function getCandidatesCount() external view returns (uint256) {
        return election.candidates.length;
    }

    function hasVoted(address voter) external view returns (bool) {
        return election.hasVoted[voter];
    }

    function hasCommitted(address voter) external view returns (bool) {
        return election.hasCommitted[voter];
    }

    function getCommit(address voter) external view returns (bytes32) {
        return election.commits[voter];
    }

    /// @notice Total number of revealed votes across all candidates.
    function getTotalVotes() external view returns (uint256 total) {
        uint256 len = election.candidates.length;
        for (uint256 i = 0; i < len; i++) {
            total += election.votes[i];
        }
    }

    /// @notice Computes the current leading candidate.
    /// @return winnerIdx Index of the candidate with the most votes.
    /// @return winnerVotes Vote count of the leading candidate.
    /// @return tied True when two or more candidates share the highest (>0) count.
    function getWinner() external view returns (uint256 winnerIdx, uint256 winnerVotes, bool tied) {
        uint256 len = election.candidates.length;
        if (len == 0) return (0, 0, false);

        winnerIdx = 0;
        winnerVotes = election.votes[0];
        for (uint256 i = 1; i < len; i++) {
            uint256 v = election.votes[i];
            if (v > winnerVotes) {
                winnerVotes = v;
                winnerIdx = i;
                tied = false;
            } else if (v == winnerVotes && v > 0) {
                tied = true;
            }
        }
    }
}